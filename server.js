const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Product = require('./models/Product');
const Order = require('./models/Order');

const app = express();
const PORT = process.env.PORT || 3000;

// ── JWT Secret (use env var in production, fallback for dev) ───────────────
const JWT_SECRET = process.env.JWT_SECRET || 'rr_super_secret_jwt_key_change_in_prod_' + Math.random();
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '956002';

// ── MongoDB Connection ─────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected');
  })
  .catch((err) => {
    console.error('❌ MongoDB Error:', err.message);
  });

// ── CORS — restrict to same origin (or env-defined allowed origin) ─────────
const allowedOrigin = process.env.ALLOWED_ORIGIN || null; // e.g. "https://yourdomain.com"
app.use(cors(allowedOrigin
  ? { origin: allowedOrigin, credentials: true }
  : { origin: /^http:\/\/localhost(:\d+)?$/, credentials: true }
));

// ── Body Parsers — reduced limit ───────────────────────────────────────────
// Images are now compressed on the client side so 10 MB is plenty
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate Limiters ──────────────────────────────────────────────────────────
// General API limit: 200 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

// Strict limit for auth endpoint: 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' }
});

// Strict limit for order placement: 20 orders per 15 minutes per IP
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

app.use('/api/', generalLimiter);

// ── Auth Middleware ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── ADMIN LOGIN ────────────────────────────────────────────────────────────
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (
    typeof username !== 'string' || typeof password !== 'string' ||
    username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD
  ) {
    // Delay response slightly to slow brute-force
    return setTimeout(() => res.status(401).json({ error: 'Invalid credentials' }), 500);
  }
  const token = jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, expiresIn: 8 * 60 * 60 });
});

// ── PRODUCTS API ───────────────────────────────────────────────────────────

// GET all products — public (customers need to browse)
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find();
    const mappedProducts = products.map(p => {
      const pObj = p.toObject();
      if (pObj.images && pObj.images.length > 0) {
        pObj.images = pObj.images.map((img, index) => {
          if (typeof img === 'string' && img.startsWith('data:')) {
            return `/api/products/${pObj.id}/image/${index}`;
          }
          return img;
        });
      }
      return pObj;
    });
    res.json(mappedProducts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// GET serve single product image — public
app.get('/api/products/:id/image/:index', async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product || !product.images || !product.images[req.params.index]) {
      return res.status(404).send('Not found');
    }
    const base64Str = product.images[req.params.index];
    const matches = base64Str.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (!matches) {
      if (base64Str.startsWith('http') || base64Str.startsWith('/')) {
        return res.redirect(base64Str);
      }
      return res.status(400).send('Invalid image format');
    }
    const contentType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// POST create product — ADMIN ONLY
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const { name, price, oldPrice, category, stock, desc, emoji, itemCode, images } = req.body;

    if (!name || !price || !category || !desc || !itemCode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const cleanedItemCode = itemCode.trim().toUpperCase();

    const existingProduct = await Product.findOne({ itemCode: cleanedItemCode });
    if (existingProduct) {
      return res.status(400).json({ error: 'Item Code must be unique' });
    }

    const imageUrls = Array.isArray(images) ? images : [];

    const product = await Product.create({
      id: uuidv4(),
      name,
      price: Number(price),
      oldPrice: oldPrice ? Number(oldPrice) : null,
      category,
      stock: Number(stock) || 0,
      desc,
      emoji: emoji || '🧵',
      itemCode: cleanedItemCode,
      images: imageUrls,
      createdAt: new Date().toISOString()
    });

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT update product — ADMIN ONLY
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const { name, price, oldPrice, category, stock, desc, emoji, keepImages, itemCode, newImages } = req.body;

    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Not found' });

    if (itemCode) {
      const cleanedItemCode = itemCode.trim().toUpperCase();
      const duplicate = await Product.findOne({
        itemCode: cleanedItemCode,
        id: { $ne: req.params.id }
      });
      if (duplicate) {
        return res.status(400).json({ error: 'Item Code must be unique' });
      }
      product.itemCode = cleanedItemCode;
    }

    const addedImages = Array.isArray(newImages) ? newImages : [];
    const existingImages = Array.isArray(keepImages) ? keepImages : (keepImages ? JSON.parse(keepImages) : []);

    const resolvedExistingImages = [];
    for (const url of existingImages) {
      if (typeof url === 'string' && url.includes(`/api/products/${req.params.id}/image/`)) {
        const parts = url.split('/');
        const index = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(index) && product.images && product.images[index]) {
          resolvedExistingImages.push(product.images[index]);
        }
      } else {
        resolvedExistingImages.push(url);
      }
    }

    if (name) product.name = name;
    if (price) product.price = Number(price);
    if (oldPrice !== undefined) product.oldPrice = oldPrice ? Number(oldPrice) : null;
    if (category) product.category = category;
    if (stock !== undefined) product.stock = Number(stock);
    if (desc) product.desc = desc;
    if (emoji) product.emoji = emoji;
    product.images = [...resolvedExistingImages, ...addedImages];
    product.updatedAt = new Date().toISOString();

    await product.save();
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// PATCH update product stock — ADMIN ONLY
app.patch('/api/products/:id/stock', requireAdmin, async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Not found' });

    product.stock = Math.max(0, Number(req.body.stock) || 0);
    await product.save();
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// DELETE product — ADMIN ONLY
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (product) {
      await Product.deleteOne({ id: req.params.id });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── ORDERS API ─────────────────────────────────────────────────────────────

// GET all orders — ADMIN ONLY
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// POST create order — public but rate limited
app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const { name, phone, email, address, payment, notes, items } = req.body;

    if (!name || !phone || !address || !payment || !items || !items.length)
      return res.status(400).json({ error: 'Missing required fields' });

    // Validate stock and calculate total server-side
    let total = 0;
    const processedItems = [];
    for (const item of items) {
      const p = await Product.findOne({ id: item.id });
      if (!p) return res.status(400).json({ error: `Product not found: ${item.id}` });
      if (p.stock < item.qty) return res.status(400).json({ error: `Insufficient stock for: ${p.name}` });
      total += p.price * item.qty;
      processedItems.push({
        id: item.id,
        name: p.name,
        price: p.price,
        qty: item.qty,
        itemCode: p.itemCode || ''
      });
    }

    const orderId = 'RR' + Date.now().toString().slice(-6);
    const order = await Order.create({
      id: orderId,
      name,
      phone,
      email: email || '',
      address,
      payment,
      notes: notes || '',
      items: processedItems,
      total,
      status: 'New',
      createdAt: new Date().toISOString(),
      date: new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to place order. Please try again.' });
  }
});

// PATCH update order status — ADMIN ONLY
app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Not found' });

    const oldStatus = order.status;
    const newStatus = req.body.status;

    // Reduce stock only first time order becomes Delivered
    if (oldStatus !== 'Delivered' && newStatus === 'Delivered') {
      for (const item of order.items) {
        const p = await Product.findOne({ id: item.id });
        if (p) {
          p.stock = Math.max(0, p.stock - item.qty);
          await p.save();
        }
      }
    }

    order.status = newStatus;
    order.updatedAt = new Date().toISOString();
    await order.save();

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// DELETE order — ADMIN ONLY
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Restore stock if the order was Delivered
    if (order.status === 'Delivered') {
      for (const item of order.items) {
        const p = await Product.findOne({ id: item.id });
        if (p) {
          p.stock += item.qty;
          await p.save();
        }
      }
    }

    await Order.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// ── Customer Order Lookup (public, rate-limited via generalLimiter) ────────

// GET track single order by ID + phone — public
app.get('/api/orders/track-single', async (req, res) => {
  try {
    const { orderId, phone } = req.query;
    if (!orderId || !phone) return res.status(400).json({ error: 'Missing Order ID or Phone Number' });

    const cleanQueryPhone = phone.replace(/\D/g, '');
    if (cleanQueryPhone.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

    const normalizedQueryId = orderId.trim().toUpperCase().replace('#', '');
    const orders = await Order.find({ id: new RegExp(`^${normalizedQueryId}$`, 'i') });
    const o = orders[0];

    if (!o) return res.status(404).json({ error: 'Order not found' });

    const cleanOrderPhone = o.phone.replace(/\D/g, '');
    if (!cleanOrderPhone.includes(cleanQueryPhone) && !cleanQueryPhone.includes(cleanOrderPhone)) {
      return res.status(403).json({ error: 'Phone number does not match this order' });
    }

    res.json(o);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST track multiple orders — public
app.post('/api/orders/track', async (req, res) => {
  try {
    const { trackList } = req.body;
    if (!trackList || !Array.isArray(trackList)) {
      return res.status(400).json({ error: 'Invalid tracking request' });
    }

    const matchedOrders = [];
    for (const item of trackList) {
      if (!item.id || !item.phone) continue;

      const normalizedId = item.id.trim().toUpperCase().replace('#', '');
      const cleanPhone = item.phone.replace(/\D/g, '');
      if (cleanPhone.length < 10) continue;

      const o = await Order.findOne({ id: new RegExp(`^${normalizedId}$`, 'i') });
      if (o) {
        const cleanOrderPhone = o.phone.replace(/\D/g, '');
        if (cleanOrderPhone.includes(cleanPhone) || cleanPhone.includes(cleanOrderPhone)) {
          matchedOrders.push(o);
        }
      }
    }

    res.json(matchedOrders);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Stats API — ADMIN ONLY ─────────────────────────────────────────────────
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [products, orders] = await Promise.all([
      Product.find(),
      Order.find()
    ]);

    res.json({
      totalProducts: products.length,
      totalOrders: orders.length,
      totalRevenue: orders
        .filter(o => o.status === 'Delivered')
        .reduce((s, o) => s + o.total, 0),
      lowStock: products.filter(p => p.stock > 0 && p.stock <= 5).length,
      outStock: products.filter(p => p.stock === 0).length,
      pendingOrders: orders.filter(o => ['New', 'Processing'].includes(o.status)).length,
      newOrders: orders.filter(o => o.status === 'New').length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── New Orders Count — public (only count, no sensitive data) ─────────────
app.get('/api/new-orders-count', async (req, res) => {
  try {
    const count = await Order.countDocuments({ status: 'New' });
    res.json({ newOrders: count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── MongoDB connection test ────────────────────────────────────────────────
app.get('/mongo-test', requireAdmin, async (req, res) => {
  res.json({
    connected: mongoose.connection.readyState === 1,
    state: mongoose.connection.readyState
  });
});

// Serve frontend for all other routes
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🪢  RakhiRoots server running at http://localhost:${PORT}`);
  console.log(`   Admin Panel: http://localhost:${PORT}/#admin`);
  console.log(`   MongoDB connected via MONGO_URI env var\n`);
  console.log(`   ⚠️  For production, set these environment variables:`);
  console.log(`      JWT_SECRET=<random-64-char-string>`);
  console.log(`      ADMIN_USERNAME=<your-username>`);
  console.log(`      ADMIN_PASSWORD=<your-strong-password>`);
  console.log(`      ALLOWED_ORIGIN=https://yourdomain.com\n`);
});

require('dotenv').config();
const express       = require('express');
const path          = require('path');
const mongoose      = require('mongoose');
const jwt           = require('jsonwebtoken');
const rateLimit     = require('express-rate-limit');
const cookieParser  = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const cloudinary    = require('cloudinary').v2;
const Product       = require('./models/Product');
const Order         = require('./models/Order');
const Category      = require('./models/Category');
const OfflineSale   = require('./models/OfflineSale');
const CashEntry     = require('./models/CashEntry');

// ── Cloudinary ─────────────────────────────────────────────────────────────
const CLOUDINARY_ENABLED = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);
if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  console.log('☁️  Cloudinary enabled');
} else {
  console.warn('⚠️  Cloudinary not configured — images stored as base64');
}

async function uploadImageToCloudinary(base64DataUri, productId, imageIndex) {
  if (!CLOUDINARY_ENABLED) return base64DataUri;
  if (!base64DataUri || !base64DataUri.startsWith('data:')) return base64DataUri;
  const result = await cloudinary.uploader.upload(base64DataUri, {
    folder: 'rakhiroots/products',
    public_id: `${productId}_img${imageIndex}_${Date.now()}`,
    overwrite: false,
    resource_type: 'image',
    quality: 'auto:good',
    fetch_format: 'auto'
  });
  return result.secure_url;
}

async function deleteImageFromCloudinary(url) {
  if (!CLOUDINARY_ENABLED || !url || !url.includes('res.cloudinary.com')) return;
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/);
    if (match && match[1]) await cloudinary.uploader.destroy(match[1]);
  } catch (e) {
    console.warn('Could not delete Cloudinary image:', url, e.message);
  }
}

// ── App Setup ───────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
// Render sets PORT automatically; ADMIN_PORT is for local dev only
const PORT = process.env.PORT || process.env.ADMIN_PORT || 4000;

const JWT_SECRET = process.env.JWT_SECRET || 'rr_super_secret_jwt_key_change_in_prod_' + Math.random();

// CRASH HARD if admin credentials are not set — never fall back to defaults in production
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error('\n❌ FATAL: ADMIN_USERNAME and ADMIN_PASSWORD environment variables must be set.');
  console.error('   Set them in your .env file (local) or Render dashboard (production).\n');
  process.exit(1);
}
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ── MongoDB ─────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected (admin server)'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// ── Rate Limiters ───────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' }
});

app.use('/api/', generalLimiter);

// ── Auth Middlewares ────────────────────────────────────────────────────────

// For API routes — returns 401 JSON if not authenticated
function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

// For HTML page routes — redirects to / (login) if not authenticated
function requireAdminPage(req, res, next) {
  const token = req.cookies && req.cookies.admin_token;
  if (!token) return res.redirect('/');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.redirect('/');
    req.admin = decoded;
    next();
  } catch (err) {
    res.clearCookie('admin_token');
    return res.redirect('/');
  }
}

// ── HTML Page Routes ────────────────────────────────────────────────────────

// Login page — auto-redirect to dashboard if already authenticated
app.get('/', (req, res) => {
  const token = req.cookies && req.cookies.admin_token;
  if (token) {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      if (d.role === 'admin') return res.redirect('/dashboard');
    } catch (_) { res.clearCookie('admin_token'); }
  }
  res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

// Admin dashboard — protected
app.get('/dashboard', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ── AUTH API ────────────────────────────────────────────────────────────────

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (
    typeof username !== 'string' || typeof password !== 'string' ||
    username !== ADMIN_USERNAME  || password !== ADMIN_PASSWORD
  ) {
    return setTimeout(() => res.status(401).json({ error: 'Invalid credentials' }), 500);
  }
  const token = jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_token', { httpOnly: true, sameSite: 'Strict' });
  res.json({ ok: true });
});

// ── CATEGORIES API ──────────────────────────────────────────────────────────

app.get('/api/categories', async (req, res) => {
  try {
    const cats = await Category.find().sort({ name: 1 });
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

app.post('/api/categories', requireAdmin, async (req, res) => {
  try {
    const { name, emoji } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    const trimmedName = name.trim();
    const existing = await Category.findOne({ name: { $regex: new RegExp(`^${trimmedName}$`, 'i') } });
    if (existing) return res.status(400).json({ error: 'Category already exists' });
    const cat = await Category.create({ name: trimmedName, emoji: emoji || '🏷️' });
    res.json(cat);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const { name, emoji } = req.body;
    const cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    if (name && name.trim()) {
      const trimmedName = name.trim();
      const duplicate = await Category.findOne({
        name: { $regex: new RegExp(`^${trimmedName}$`, 'i') },
        _id: { $ne: cat._id }
      });
      if (duplicate) return res.status(400).json({ error: 'Category name already exists' });
      await Product.updateMany({ category: cat.name }, { $set: { category: trimmedName } });
      cat.name = trimmedName;
    }
    if (emoji) cat.emoji = emoji;
    await cat.save();
    res.json(cat);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    const inUse = await Product.countDocuments({ category: cat.name });
    if (inUse > 0) return res.status(400).json({ error: `Cannot delete — ${inUse} product(s) use this category` });
    await Category.deleteOne({ _id: cat._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ── PRODUCTS API ────────────────────────────────────────────────────────────

app.get('/api/products', async (req, res) => {
  try {
    const [products, imageCounts] = await Promise.all([
      Product.find().select('-images').lean(),
      Product.aggregate([
        { $project: { id: 1, imageCount: { $size: { $ifNull: ['$images', []] } } } }
      ])
    ]);
    const countMap = {};
    for (const p of imageCounts) countMap[p.id] = p.imageCount || 0;
    const mapped = products.map(p => {
      const count = countMap[p.id] || 0;
      p.images = Array.from({ length: count }, (_, i) => `/api/products/${p.id}/image/${i}`);
      return p;
    });
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products' });
  }
});

app.get('/api/products/:id/image/:index', async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product || !product.images || !product.images[req.params.index]) {
      return res.status(404).send('Not found');
    }
    const base64Str = product.images[req.params.index];
    const commaIdx = base64Str.indexOf(',');
    if (commaIdx !== -1 && base64Str.startsWith('data:')) {
      const meta = base64Str.substring(5, commaIdx);
      const base64Data = base64Str.substring(commaIdx + 1);
      let contentType = 'image/jpeg';
      if (meta) {
        const parts = meta.split(';');
        if (parts[0] && parts[0] !== 'base64') contentType = parts[0];
      }
      const buffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(buffer);
    }
    if (base64Str.startsWith('http') || base64Str.startsWith('/')) {
      return res.redirect(base64Str);
    }
    return res.status(400).send('Invalid image format');
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const { name, price, oldPrice, category, stock, desc, emoji, itemCode, images, colors } = req.body;
    if (!name || !price || !category || !desc || !itemCode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const cleanedItemCode = itemCode.trim().toUpperCase();
    const existingProduct = await Product.findOne({ itemCode: cleanedItemCode });
    if (existingProduct) return res.status(400).json({ error: 'Item Code must be unique' });

    const productId = uuidv4();
    const rawImages = Array.isArray(images) ? images : [];
    const imageUrls = await Promise.all(
      rawImages.map((img, i) => uploadImageToCloudinary(img, productId, i))
    );
    const product = await Product.create({
      id: productId, name,
      price: Number(price),
      oldPrice: oldPrice ? Number(oldPrice) : null,
      category,
      stock: Number(stock) || 0,
      desc,
      emoji: emoji || '🧵',
      itemCode: cleanedItemCode,
      images: imageUrls,
      colors: Array.isArray(colors) ? colors : [],
      createdAt: new Date().toISOString()
    });
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create product: ' + err.message });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const { name, price, oldPrice, category, stock, desc, emoji, keepImages, itemCode, newImages, colors } = req.body;
    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Not found' });

    if (itemCode) {
      const cleanedItemCode = itemCode.trim().toUpperCase();
      const duplicate = await Product.findOne({ itemCode: cleanedItemCode, id: { $ne: req.params.id } });
      if (duplicate) return res.status(400).json({ error: 'Item Code must be unique' });
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

    if (CLOUDINARY_ENABLED && product.images && product.images.length > 0) {
      const removedImages = product.images.filter(img => !resolvedExistingImages.includes(img));
      await Promise.all(removedImages.map(img => deleteImageFromCloudinary(img)));
    }

    const uploadedNewImages = await Promise.all(
      addedImages.map((img, i) => uploadImageToCloudinary(img, req.params.id, resolvedExistingImages.length + i))
    );

    if (name)             product.name      = name;
    if (price)            product.price     = Number(price);
    if (oldPrice !== undefined) product.oldPrice = oldPrice ? Number(oldPrice) : null;
    if (category)         product.category  = category;
    if (stock !== undefined)   product.stock = Number(stock);
    if (desc)             product.desc      = desc;
    if (emoji)            product.emoji     = emoji;
    if (colors !== undefined)  product.colors = Array.isArray(colors) ? colors : [];
    product.images    = [...resolvedExistingImages, ...uploadedNewImages];
    product.updatedAt = new Date().toISOString();

    await product.save();
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product: ' + err.message });
  }
});

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

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (product) await Product.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── ORDERS API ──────────────────────────────────────────────────────────────

app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    // Return plain array — matches what admin/index.html expects
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Not found' });

    const oldStatus = order.status;
    const newStatus = req.body.status;
    const ALLOWED = ['New', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!ALLOWED.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${ALLOWED.join(', ')}` });
    }

    if (oldStatus !== 'Delivered' && newStatus === 'Delivered') {
      for (const item of order.items) {
        const p = await Product.findOne({ id: item.id });
        if (p) { p.stock = Math.max(0, p.stock - item.qty); await p.save(); }
      }
    }
    order.status    = newStatus;
    order.updatedAt = new Date().toISOString();
    await order.save();
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { name, phone, email, address, notes, items } = req.body;
    if (name    && name.trim())    order.name    = name.trim();
    if (phone   && phone.trim())   order.phone   = phone.trim();
    if (email   !== undefined)     order.email   = email || '';
    if (address && address.trim()) order.address = address.trim();
    if (notes   !== undefined)     order.notes   = notes || '';

    if (Array.isArray(items)) {
      if (items.length === 0) return res.status(400).json({ error: 'Order must have at least one item' });

      let newTotal = 0;
      const updatedItems = [];

      for (const incoming of items) {
        const qty = parseInt(incoming.qty, 10);
        if (!Number.isInteger(qty) || qty < 0) {
          return res.status(400).json({ error: `Invalid quantity for item ${incoming.id}` });
        }

        const existing = order.items.find(i => i.id === incoming.id);

        if (!existing) {
          if (qty === 0) continue;
          const p = await Product.findOne({ id: incoming.id });
          if (!p) return res.status(400).json({ error: `Product not found: ${incoming.id}` });
          updatedItems.push({ id: p.id, name: p.name, price: p.price, qty, itemCode: p.itemCode });
          newTotal += p.price * qty;
          if (order.status === 'Delivered') { p.stock = Math.max(0, p.stock - qty); await p.save(); }
          continue;
        }

        if (qty === 0) {
          if (order.status === 'Delivered') {
            const p = await Product.findOne({ id: existing.id });
            if (p) { p.stock += existing.qty; await p.save(); }
          }
          continue;
        }

        if (order.status === 'Delivered' && qty < existing.qty) {
          const diff = existing.qty - qty;
          const p = await Product.findOne({ id: existing.id });
          if (p) { p.stock += diff; await p.save(); }
        } else if (order.status === 'Delivered' && qty > existing.qty) {
          const diff = qty - existing.qty;
          const p = await Product.findOne({ id: existing.id });
          if (p) { p.stock = Math.max(0, p.stock - diff); await p.save(); }
        }

        updatedItems.push({ ...existing.toObject(), qty });
        newTotal += existing.price * qty;
      }

      if (updatedItems.length === 0) return res.status(400).json({ error: 'Order must have at least one item remaining' });
      order.items = updatedItems;
      order.total = Math.round(newTotal * 100) / 100;
    }

    order.updatedAt = new Date().toISOString();
    await order.save();
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'Delivered') {
      for (const item of order.items) {
        const p = await Product.findOne({ id: item.id });
        if (p) { p.stock += item.qty; await p.save(); }
      }
    }
    await Order.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// ── STATS & MISC ────────────────────────────────────────────────────────────

app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [totalProducts, totalOrders, lowStock, outStock, pendingOrders, newOrders, revenueAgg, offlineRevenueAgg] = await Promise.all([
      Product.countDocuments(),
      Order.countDocuments(),
      Product.countDocuments({ stock: { $gt: 0, $lte: 5 } }),
      Product.countDocuments({ stock: 0 }),
      Order.countDocuments({ status: { $in: ['New', 'Processing'] } }),
      Order.countDocuments({ status: 'New' }),
      Order.aggregate([{ $match: { status: 'Delivered' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      OfflineSale.aggregate([{ $group: { _id: null, total: { $sum: { $ifNull: ['$finalAmount', { $ifNull: ['$amount', 0] }] } } } }])
    ]);
    res.json({
      totalProducts,
      totalOrders,
      totalRevenue: (revenueAgg[0]?.total || 0) + (offlineRevenueAgg[0]?.total || 0),
      lowStock,
      outStock,
      pendingOrders,
      newOrders
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.get('/api/new-orders-count', requireAdmin, async (req, res) => {
  try {
    const count = await Order.countDocuments({ status: 'New' });
    res.json({ newOrders: count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/mongo-test', requireAdmin, async (req, res) => {
  res.json({ connected: mongoose.connection.readyState === 1, state: mongoose.connection.readyState });
});

// ── OFFLINE SALES API ───────────────────────────────────────────────────────

app.get('/api/offline-sales', requireAdmin, async (req, res) => {
  try {
    const sales = await OfflineSale.find().sort({ date: -1, createdAt: -1 });
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load offline sales' });
  }
});

app.post('/api/offline-sales', requireAdmin, async (req, res) => {
  try {
    const { items, discount, note, date } = req.body;
    if (!Array.isArray(items) || items.length === 0 || !date)
      return res.status(400).json({ error: 'Missing required fields (items, date)' });

    const processedItems = [];
    for (const item of items) {
      const qty       = Number(item.qty);
      const unitPrice = Number(item.unitPrice);
      if (!item.itemName || isNaN(qty) || qty < 1 || isNaN(unitPrice) || unitPrice < 0)
        return res.status(400).json({ error: 'Each item must have a name, valid qty and unit price' });

      const lineTotal          = Math.round(qty * unitPrice * 100) / 100;
      let resolvedItemCode = (item.itemCode || '').trim().toUpperCase();
      let resolvedItemName = item.itemName.trim();

      if (resolvedItemCode) {
        const product = await Product.findOne({ itemCode: resolvedItemCode });
        if (!product) return res.status(400).json({ error: `No product found with item code: ${resolvedItemCode}` });
        if (product.stock < qty) return res.status(400).json({ error: `Insufficient stock for "${product.name}". Available: ${product.stock}` });
        product.stock = Math.max(0, product.stock - qty);
        await product.save();
        resolvedItemName = product.name;
      }
      processedItems.push({ itemCode: resolvedItemCode, itemName: resolvedItemName, qty, unitPrice, lineTotal });
    }

    const subTotal    = Math.round(processedItems.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
    const discountAmt = Math.max(0, Number(discount) || 0);
    const finalAmount = Math.max(0, Math.round((subTotal - discountAmt) * 100) / 100);

    const sale = await OfflineSale.create({ items: processedItems, subTotal, discount: discountAmt, finalAmount, note: (note || '').trim(), date });
    res.json(sale);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record sale' });
  }
});

app.delete('/api/offline-sales/:id', requireAdmin, async (req, res) => {
  try {
    const sale = await OfflineSale.findById(req.params.id);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    for (const item of (sale.items || [])) {
      if (item.itemCode) {
        const product = await Product.findOne({ itemCode: item.itemCode });
        if (product) { product.stock += item.qty; await product.save(); }
      }
    }
    await OfflineSale.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sale' });
  }
});

// ── CASH LEDGER API ─────────────────────────────────────────────────────────

app.get('/api/cash-entries', requireAdmin, async (req, res) => {
  try {
    const entries = await CashEntry.find().sort({ date: -1, createdAt: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cash entries' });
  }
});

app.post('/api/cash-entries', requireAdmin, async (req, res) => {
  try {
    const { type, amount, description, date } = req.body;
    if (!type || !amount || !date) return res.status(400).json({ error: 'Missing required fields' });
    if (!['income', 'expense', 'pending'].includes(type))
      return res.status(400).json({ error: 'Type must be income, expense, or pending' });
    const entry = await CashEntry.create({ type, amount: Number(amount), description: (description || '').trim(), date });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record entry' });
  }
});

app.patch('/api/cash-entries/:id/mark-paid', requireAdmin, async (req, res) => {
  try {
    const entry = await CashEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.type !== 'pending') return res.status(400).json({ error: 'Entry is not pending' });
    entry.type  = 'income';
    entry.paidAt = new Date().toISOString();
    await entry.save();
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark entry as paid' });
  }
});

app.delete('/api/cash-entries/:id', requireAdmin, async (req, res) => {
  try {
    await CashEntry.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🔐  RakhiRoots ADMIN server running at http://localhost:${PORT}`);
  console.log(`   Login at: http://localhost:${PORT}/`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard  (requires login)\n`);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const Product = require('./models/Product');
const Order = require('./models/Order');
const Category = require('./models/Category');
const OfflineSale = require('./models/OfflineSale');
const CashEntry = require('./models/CashEntry');

// ── Cloudinary Configuration ───────────────────────────────────────────────
// Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in env
const CLOUDINARY_ENABLED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  console.log('☁️  Cloudinary enabled — images will be uploaded to CDN');
} else {
  console.warn('⚠️  Cloudinary not configured — images stored as base64 (not recommended for production)');
}

/**
 * Upload a base64 data-URI to Cloudinary.
 * Returns the secure HTTPS URL or the original string if Cloudinary is not configured.
 */
async function uploadImageToCloudinary(base64DataUri, productId, imageIndex) {
  if (!CLOUDINARY_ENABLED) return base64DataUri; // fallback: store as-is
  if (!base64DataUri || !base64DataUri.startsWith('data:')) return base64DataUri; // already a URL
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

/**
 * Delete an image from Cloudinary by its URL.
 * Extracts the public_id from the URL and destroys it.
 */
async function deleteImageFromCloudinary(url) {
  if (!CLOUDINARY_ENABLED || !url || !url.includes('res.cloudinary.com')) return;
  try {
    // Extract public_id from URL: everything between /upload/vXXX/ and the extension
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z]+)?$/);
    if (match && match[1]) {
      await cloudinary.uploader.destroy(match[1]);
    }
  } catch (e) {
    console.warn('Could not delete Cloudinary image:', url, e.message);
  }
}

const app = express();
// Trust proxy is required when deploying to platforms like Render
app.set('trust proxy', 1);
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

// ── Body Parsers ───────────────────────────────────────────────────────────
// When Cloudinary is enabled images are uploaded directly from the browser
// to Cloudinary, so the server only receives lightweight JSON (URLs).
// We keep 10 MB as a fallback for when Cloudinary is not configured.
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

// ── CATEGORIES API ────────────────────────────────────────────────────────

// GET all categories — public
app.get('/api/categories', async (req, res) => {
  try {
    const cats = await Category.find().sort({ name: 1 });
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// POST create category — ADMIN ONLY
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

// PUT rename/update category — ADMIN ONLY
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
      // Also rename the category on all products that use it
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

// DELETE category — ADMIN ONLY
app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    // Check if any product is using this category
    const inUse = await Product.countDocuments({ category: cat.name });
    if (inUse > 0) return res.status(400).json({ error: `Cannot delete — ${inUse} product(s) use this category` });
    await Category.deleteOne({ _id: cat._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ── PRODUCTS API ───────────────────────────────────────────────────────────

// GET all products — public (customers need to browse)
// NOTE: We exclude the raw base64 image data from the list response to avoid
// loading potentially hundreds of MB of image strings into RAM all at once.
// Images are served individually via /api/products/:id/image/:index instead.
app.get('/api/products', async (req, res) => {
  try {
    // Run both queries in parallel:
    // 1. All product fields EXCEPT images (avoids loading base64 blobs into RAM)
    // 2. Aggregation that counts images per product without fetching their data
    const [products, imageCounts] = await Promise.all([
      Product.find().select('-images').lean(),
      Product.aggregate([
        { $project: { id: 1, imageCount: { $size: { $ifNull: ['$images', []] } } } }
      ])
    ]);

    // Build a fast lookup map: product.id → number of images
    const countMap = {};
    for (const p of imageCounts) {
      countMap[p.id] = p.imageCount || 0;
    }

    // Attach image URL references (not actual base64 data) so the client
    // can lazy-load each image via /api/products/:id/image/:index
    const mappedProducts = products.map(p => {
      const count = countMap[p.id] || 0;
      p.images = Array.from({ length: count }, (_, i) => `/api/products/${p.id}/image/${i}`);
      return p;
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

// POST create product — ADMIN ONLY
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const { name, price, oldPrice, category, stock, desc, emoji, itemCode, images, colors } = req.body;

    if (!name || !price || !category || !desc || !itemCode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const cleanedItemCode = itemCode.trim().toUpperCase();
    const existingProduct = await Product.findOne({ itemCode: cleanedItemCode });
    if (existingProduct) {
      return res.status(400).json({ error: 'Item Code must be unique' });
    }

    const productId = uuidv4();
    const rawImages = Array.isArray(images) ? images : [];

    // Upload any base64 images to Cloudinary; URLs pass through unchanged
    const imageUrls = await Promise.all(
      rawImages.map((img, i) => uploadImageToCloudinary(img, productId, i))
    );

    const product = await Product.create({
      id: productId,
      name,
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

// PUT update product — ADMIN ONLY
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const { name, price, oldPrice, category, stock, desc, emoji, keepImages, itemCode, newImages, colors } = req.body;

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

    // Resolve /api/products/:id/image/:index references back to actual stored values
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

    // Delete Cloudinary images that were removed by the admin
    if (CLOUDINARY_ENABLED && product.images && product.images.length > 0) {
      const removedImages = product.images.filter(img => !resolvedExistingImages.includes(img));
      await Promise.all(removedImages.map(img => deleteImageFromCloudinary(img)));
    }

    // Upload any new base64 images to Cloudinary (existing URLs pass through)
    const uploadedNewImages = await Promise.all(
      addedImages.map((img, i) => uploadImageToCloudinary(img, req.params.id, resolvedExistingImages.length + i))
    );

    if (name) product.name = name;
    if (price) product.price = Number(price);
    if (oldPrice !== undefined) product.oldPrice = oldPrice ? Number(oldPrice) : null;
    if (category) product.category = category;
    if (stock !== undefined) product.stock = Number(stock);
    if (desc) product.desc = desc;
    if (emoji) product.emoji = emoji;
    if (colors !== undefined) product.colors = Array.isArray(colors) ? colors : [];
    product.images = [...resolvedExistingImages, ...uploadedNewImages];
    product.updatedAt = new Date().toISOString();

    await product.save();
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product: ' + err.message });
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
// Uses DB-level aggregations instead of loading all documents into RAM
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [totalProducts, totalOrders, lowStock, outStock, pendingOrders, newOrders, revenueAgg, offlineRevenueAgg] = await Promise.all([
      Product.countDocuments(),
      Order.countDocuments(),
      Product.countDocuments({ stock: { $gt: 0, $lte: 5 } }),
      Product.countDocuments({ stock: 0 }),
      Order.countDocuments({ status: { $in: ['New', 'Processing'] } }),
      Order.countDocuments({ status: 'New' }),
      // Sum total for delivered online orders using aggregation (no full document load)
      Order.aggregate([
        { $match: { status: 'Delivered' } },
        { $group: { _id: null, total: { $sum: '$total' } } }
      ]),
      // Sum offline sales revenue using aggregation
      OfflineSale.aggregate([
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    const onlineRevenue = revenueAgg[0]?.total || 0;
    const offlineRevenue = offlineRevenueAgg[0]?.total || 0;

    res.json({
      totalProducts,
      totalOrders,
      totalRevenue: onlineRevenue + offlineRevenue,
      lowStock,
      outStock,
      pendingOrders,
      newOrders,
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

// ── OFFLINE SALES API ─────────────────────────────────────────────────────

// GET all offline sales — ADMIN ONLY
app.get('/api/offline-sales', requireAdmin, async (req, res) => {
  try {
    const sales = await OfflineSale.find().sort({ date: -1, createdAt: -1 });
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load offline sales' });
  }
});

// POST create offline sale — ADMIN ONLY
app.post('/api/offline-sales', requireAdmin, async (req, res) => {
  try {
    const { itemCode, qty, amount, note, date } = req.body;
    if (!itemCode || !qty || !amount || !date)
      return res.status(400).json({ error: 'Missing required fields' });
    // Look up product by item code
    const product = await Product.findOne({ itemCode: itemCode.trim().toUpperCase() });
    if (!product)
      return res.status(400).json({ error: `No product found with item code: ${itemCode.trim().toUpperCase()}` });
    // Check sufficient stock
    if (product.stock < Number(qty))
      return res.status(400).json({ error: `Insufficient stock. Available: ${product.stock}` });
    // Deduct stock
    product.stock = Math.max(0, product.stock - Number(qty));
    await product.save();
    const sale = await OfflineSale.create({
      itemCode: itemCode.trim().toUpperCase(),
      itemName: product.name,
      qty: Number(qty),
      amount: Number(amount),
      note: (note || '').trim(),
      date
    });
    res.json(sale);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record sale' });
  }
});

// DELETE offline sale — ADMIN ONLY (restores stock)
app.delete('/api/offline-sales/:id', requireAdmin, async (req, res) => {
  try {
    const sale = await OfflineSale.findById(req.params.id);
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    // Restore stock
    const product = await Product.findOne({ itemCode: sale.itemCode });
    if (product) {
      product.stock += sale.qty;
      await product.save();
    }
    await OfflineSale.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sale' });
  }
});

// ── CASH LEDGER API ───────────────────────────────────────────────────────

// GET all cash entries — ADMIN ONLY
app.get('/api/cash-entries', requireAdmin, async (req, res) => {
  try {
    const entries = await CashEntry.find().sort({ date: -1, createdAt: -1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cash entries' });
  }
});

// POST create cash entry — ADMIN ONLY
app.post('/api/cash-entries', requireAdmin, async (req, res) => {
  try {
    const { type, amount, description, date } = req.body;
    if (!type || !amount || !date)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!['income', 'expense'].includes(type))
      return res.status(400).json({ error: 'Type must be income or expense' });
    const entry = await CashEntry.create({
      type,
      amount: Number(amount),
      description: (description || '').trim(),
      date
    });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record entry' });
  }
});

// DELETE cash entry — ADMIN ONLY
app.delete('/api/cash-entries/:id', requireAdmin, async (req, res) => {
  try {
    await CashEntry.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete entry' });
  }
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

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Paths ──────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── JSON DB helpers ────────────────────────────────────────────────────────
function readJSON(file, defaults) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return defaults; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Seed demo products if none exist
if (!fs.existsSync(PRODUCTS_FILE)) {
  const demo = [
    { id: uuidv4(), name: 'Golden Zari Rakhi', price: 199, oldPrice: 299, category: 'Designer', stock: 30, desc: 'Elegant rakhi with golden zari thread and intricate beadwork. Perfect for gifting.', images: [], emoji: '🌟', createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Peacock Feather Rakhi', price: 249, oldPrice: 349, category: 'Designer', stock: 15, desc: 'Beautifully crafted peacock feather design with turquoise and gold beads.', images: [], emoji: '🦚', createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Kids Cartoon Rakhi – Dino', price: 99, oldPrice: 149, category: 'Kids', stock: 50, desc: 'Fun dinosaur-themed rakhi kids will love. Safe elastic band.', images: [], emoji: '🦕', createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Silver Om Bracelet Rakhi', price: 499, oldPrice: 699, category: 'Silver / Metal', stock: 8, desc: 'Premium silver-plated Om charm rakhi, ideal for special occasions.', images: [], emoji: '🕉️', createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Red Silk Thread Rakhi', price: 79, oldPrice: null, category: 'Thread', stock: 0, desc: 'Traditional red silk thread with golden charm – simple and auspicious.', images: [], emoji: '🔴', createdAt: new Date().toISOString() },
    { id: uuidv4(), name: 'Pearl & Rose Combo Set', price: 599, oldPrice: 799, category: 'Combo Set', stock: 20, desc: 'Set of 3 rakhis with pearl clusters and rose motif. Comes in premium box.', images: [], emoji: '🌸', createdAt: new Date().toISOString() },
  ];
  writeJSON(PRODUCTS_FILE, demo);
}
if (!fs.existsSync(ORDERS_FILE)) writeJSON(ORDERS_FILE, []);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer — disk storage for product images
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// ── PRODUCTS API ───────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  res.json(products);
});

app.post('/api/products', upload.array('images', 10), (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const { name, price, oldPrice, category, stock, desc, emoji } = req.body;
  if (!name || !price || !category || !desc) return res.status(400).json({ error: 'Missing required fields' });

  const imageUrls = (req.files || []).map(f => `/uploads/${f.filename}`);
  const product = {
    id: uuidv4(), name, price: Number(price),
    oldPrice: oldPrice ? Number(oldPrice) : null,
    category, stock: Number(stock) || 0, desc,
    emoji: emoji || '🪢',
    images: imageUrls,
    createdAt: new Date().toISOString()
  };
  products.unshift(product);
  writeJSON(PRODUCTS_FILE, products);
  res.json(product);
});

app.put('/api/products/:id', upload.array('images', 10), (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { name, price, oldPrice, category, stock, desc, emoji, keepImages } = req.body;
  const newImages = (req.files || []).map(f => `/uploads/${f.filename}`);
  const existingImages = keepImages ? JSON.parse(keepImages) : [];

  products[idx] = {
    ...products[idx],
    name: name || products[idx].name,
    price: price ? Number(price) : products[idx].price,
    oldPrice: oldPrice !== undefined ? (oldPrice ? Number(oldPrice) : null) : products[idx].oldPrice,
    category: category || products[idx].category,
    stock: stock !== undefined ? Number(stock) : products[idx].stock,
    desc: desc || products[idx].desc,
    emoji: emoji || products[idx].emoji,
    images: [...existingImages, ...newImages],
    updatedAt: new Date().toISOString()
  };
  writeJSON(PRODUCTS_FILE, products);
  res.json(products[idx]);
});

app.patch('/api/products/:id/stock', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const p = products.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.stock = Math.max(0, Number(req.body.stock) || 0);
  writeJSON(PRODUCTS_FILE, products);
  res.json(p);
});

app.delete('/api/products/:id', (req, res) => {
  let products = readJSON(PRODUCTS_FILE, []);
  const p = products.find(x => x.id === req.params.id);
  if (p) {
    // Delete image files from disk
    (p.images || []).forEach(imgPath => {
      const fullPath = path.join(__dirname, 'public', imgPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    });
  }
  products = products.filter(x => x.id !== req.params.id);
  writeJSON(PRODUCTS_FILE, products);
  res.json({ ok: true });
});

// ── ORDERS API ─────────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  res.json(orders);
});

app.post('/api/orders', (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  const products = readJSON(PRODUCTS_FILE, []);
  const { name, phone, email, address, payment, notes, items } = req.body;

  if (!name || !phone || !address || !payment || !items || !items.length)
    return res.status(400).json({ error: 'Missing required fields' });

  // Validate stock and calculate total
  let total = 0;
  for (const item of items) {
    const p = products.find(x => x.id === item.id);
    if (!p) return res.status(400).json({ error: `Product not found: ${item.id}` });
    if (p.stock < item.qty) return res.status(400).json({ error: `Insufficient stock for: ${p.name}` });
    total += p.price * item.qty;
  }

  // Deduct stock
  for (const item of items) {
    const p = products.find(x => x.id === item.id);
    p.stock -= item.qty;
  }
  writeJSON(PRODUCTS_FILE, products);

  const orderId = 'RR' + Date.now().toString().slice(-6);
  const order = {
    id: orderId, name, phone, email: email || '', address, payment,
    notes: notes || '', items, total, status: 'New',
    createdAt: new Date().toISOString(),
    date: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  };
  orders.unshift(order);
  writeJSON(ORDERS_FILE, orders);
  res.json(order);
});

app.patch('/api/orders/:id/status', (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  const o = orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  o.status = req.body.status;
  o.updatedAt = new Date().toISOString();
  writeJSON(ORDERS_FILE, orders);
  res.json(o);
});

// ── Stats API ──────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const orders = readJSON(ORDERS_FILE, []);
  res.json({
    totalProducts: products.length,
    totalOrders: orders.length,
    totalRevenue: orders.reduce((s, o) => s + o.total, 0),
    lowStock: products.filter(p => p.stock > 0 && p.stock <= 5).length,
    outStock: products.filter(p => p.stock === 0).length,
    pendingOrders: orders.filter(o => ['New', 'Processing'].includes(o.status)).length,
    newOrders: orders.filter(o => o.status === 'New').length,
  });
});

// Serve frontend for all other routes
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🪢  RakhiRoots server running at http://localhost:${PORT}`);
  console.log(`   Admin Panel: http://localhost:${PORT}/#admin`);
  console.log(`   Data stored in: ${DATA_DIR}\n`);
});

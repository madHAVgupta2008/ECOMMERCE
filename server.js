require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const Product = require('./models/Product');
const Order = require('./models/Order');
const Category = require('./models/Category');
const Review = require('./models/Review');


const app = express();
// Trust proxy is required when deploying to platforms like Render
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

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

// ── Compression — gzip/deflate responses for faster page loads ────────────
app.use(compression());

// ── Rate Limiters ──────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // Lowered from 1000 — blocks bots while allowing real users
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
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

// ── Admin auth, login, and all admin-only routes have been moved to admin-server.js
// This server only exposes public-facing APIs.

// ── CATEGORIES API (public read) ───────────────────────────────────────────
// Write operations (POST/PUT/DELETE) are handled by admin-server.js

app.get('/api/categories', async (req, res) => {
  try {
    const cats = await Category.find().sort({ name: 1 });
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load categories' });
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

// Product write operations (POST/PUT/PATCH/DELETE) are handled by admin-server.js

// ── ORDERS API (public write + public tracking) ────────────────────────────
// Admin order management (GET all, PATCH status, PUT edit, DELETE) is in admin-server.js

// POST create order — public but rate limited
app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const { name, phone, email, address, payment, notes, items } = req.body;

    if (!name || !phone || !address || !payment || !items || !items.length)
      return res.status(400).json({ error: 'Missing required fields' });

    // ── Field Length Validation ──────────────────────────────────────────────
    if (name.length > 100)
      return res.status(400).json({ error: 'Name is too long (max 100 characters).' });
    if (address.length > 500)
      return res.status(400).json({ error: 'Address is too long (max 500 characters).' });
    if (notes && notes.length > 1000)
      return res.status(400).json({ error: 'Notes are too long (max 1000 characters).' });

    // ── Phone Number Validation ──────────────────────────────────────────────
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 15)
      return res.status(400).json({ error: 'Invalid phone number. Must be 10–15 digits.' });

    // ── Cart Size Cap ────────────────────────────────────────────────────────
    if (items.length > 20)
      return res.status(400).json({ error: 'Cart cannot exceed 20 different items.' });

    // Validate payment method against allowed values
    const ALLOWED_PAYMENTS = ['UPI / QR Code'];
    if (!ALLOWED_PAYMENTS.includes(payment)) {
      return res.status(400).json({ error: `Invalid payment method.` });
    }
    // Validate stock and calculate total server-side
    let total = 0;
    const processedItems = [];
    const decrementedItems = []; // Track decremented items for rollback

    for (const item of items) {
      // ── FIX #5: Validate qty is a positive integer ──────────────────────
      const qty = parseInt(item.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        // Rollback already decremented items
        for (const dec of decrementedItems) {
          await Product.updateOne({ id: dec.id }, { $inc: { stock: dec.qty } });
        }
        return res.status(400).json({ error: `Invalid quantity for item: ${item.id}. Quantity must be a positive whole number.` });
      }

      // ── Per-Item Quantity Cap ──────────────────────────────────────────────
      if (qty > 100) {
        for (const dec of decrementedItems) {
          await Product.updateOne({ id: dec.id }, { $inc: { stock: dec.qty } });
        }
        return res.status(400).json({ error: `Quantity for item ${item.id} cannot exceed 100 per order.` });
      }

      // Atomically check stock and decrement
      const p = await Product.findOneAndUpdate(
        { id: item.id, stock: { $gte: qty } },
        { $inc: { stock: -qty } },
        { new: true }
      );

      if (!p) {
        // Rollback already decremented items
        for (const dec of decrementedItems) {
          await Product.updateOne({ id: dec.id }, { $inc: { stock: dec.qty } });
        }
        
        // Find if product exists to give a specific error message
        const existingP = await Product.findOne({ id: item.id });
        if (!existingP) {
          return res.status(400).json({ error: `Product not found: ${item.id}` });
        } else {
          return res.status(400).json({ error: `Insufficient stock for: ${existingP.name}` });
        }
      }

      decrementedItems.push({ id: item.id, qty });
      
      total += p.price * qty;
      processedItems.push({
        id: item.id,
        name: p.name,
        price: p.price,
        qty,
        itemCode: p.itemCode || '',
        color: item.color || ''
      });
    }

    // Generate order ID: RR + 6 random digits. Loop to guarantee it's unique and no collisions occur.
    let orderId;
    let isUnique = false;
    while (!isUnique) {
      orderId = 'RR' + Math.floor(100000 + Math.random() * 900000);
      const existing = await Order.findOne({ id: orderId });
      if (!existing) {
        isUnique = true;
      }
    }

    try {
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
    } catch (orderErr) {
      // Rollback stock if order creation fails
      for (const dec of decrementedItems) {
        await Product.updateOne({ id: dec.id }, { $inc: { stock: dec.qty } });
      }
      throw orderErr; // Let the outer catch handle the response
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to place order. Please try again.' });
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
    // Escape special regex characters to prevent ReDoS attacks
    const escapedId = normalizedQueryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orders = await Order.find({ id: new RegExp(`^${escapedId}$`, 'i') });
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
    // Cap list size to prevent DoS via excessive DB queries
    if (trackList.length > 20) {
      return res.status(400).json({ error: 'Too many items in tracking request (max 20)' });
    }

    const matchedOrders = [];
    for (const item of trackList) {
      if (!item.id || !item.phone) continue;

      const normalizedId = item.id.trim().toUpperCase().replace('#', '');
      // Escape special regex characters to prevent ReDoS attacks
      const escapedId = normalizedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cleanPhone = item.phone.replace(/\D/g, '');
      if (cleanPhone.length < 10) continue;

      const o = await Order.findOne({ id: new RegExp(`^${escapedId}$`, 'i') });
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

// ── REVIEWS API (public read & write with MongoDB persistence) ───────────────
app.get('/api/reviews', async (req, res) => {
  try {
    const reviews = await Review.find().sort({ createdAt: -1 }).lean();
    res.json(reviews);
  } catch (err) {
    console.error('Failed to load reviews:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const { name, location, rating, text } = req.body;
    if (!name || !rating || !text) {
      return res.status(400).json({ error: 'Name, rating and review text are required.' });
    }

    const review = await Review.create({
      name: String(name).trim(),
      location: String(location || '').trim(),
      rating: Number(rating),
      text: String(text).trim(),
      createdAt: new Date(),
      ts: Date.now()
    });

    res.json(review);
  } catch (err) {
    console.error('Failed to save review:', err);
    res.status(500).json({ error: 'Failed to save review' });
  }
});



// Serve frontend for all other routes
app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🪢  RakhiRoots PUBLIC SHOP running at http://localhost:${PORT}`);
  console.log(`   Admin panel → run: npm run admin  (http://localhost:4000)`);
  console.log(`   MongoDB connected via MONGO_URI env var\n`);
});

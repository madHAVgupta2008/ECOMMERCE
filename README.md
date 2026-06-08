# 🪢 RakhiRoots – Full-Stack Rakhi Business Website

## Quick Start (2 minutes)

### Prerequisites
- [Node.js](https://nodejs.org) v18 or higher

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
# Shop:  http://localhost:3000
# Admin: http://localhost:3000  → click ⚙️ Admin tab
```

---

## Features

### 🛍️ Customer Shop
- Browse all rakhis with photos, descriptions, prices
- Filter by category (Designer, Kids, Silver, etc.)
- Search by name or description
- Add to cart, adjust quantities
- Checkout with name, phone, address, payment mode
- Order confirmation with unique Order ID

### ⚙️ Admin Panel
- **Dashboard** – live stats: total products, orders, revenue, new/pending orders, low stock alerts
- **My Products** – view all, update stock directly, edit or delete
- **Add Product** – upload real photos, set name, description, price, MRP, category, stock
- **Orders** – full customer order list with all details; update status (New → Processing → Dispatched → Delivered)
- Auto-refreshes new order badge every 30 seconds

---

## Data Storage
All data is saved as JSON files in the `data/` folder:
- `data/products.json` — your product catalog
- `data/orders.json` — all customer orders

Product images are saved in `public/uploads/`.

## Deployment
To host online, deploy to any Node.js host:
- **Railway** (free): https://railway.app
- **Render** (free): https://render.com
- **Vercel** (with minor config)

Just upload this folder and set `npm start` as the start command.

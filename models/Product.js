const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  itemCode: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  oldPrice: { type: Number, default: null },
  category: { type: String, required: true },
  stock: { type: Number, default: 0 },
  desc: { type: String, default: '' },
  emoji: { type: String, default: '🧵' },
  images: { type: [String], default: [] },
  createdAt: { type: String, default: () => new Date().toISOString() },
  updatedAt: { type: String, default: null }
});

module.exports = mongoose.model('Product', ProductSchema);
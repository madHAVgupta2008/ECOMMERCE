const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  id: String,
  name: String,
  itemCode: String,
  price: Number,
  oldPrice: Number,
  category: String,
  stock: Number,
  desc: String,
  emoji: String,
  images: [String],
  createdAt: String,
  updatedAt: String
});

module.exports = mongoose.model('Product', ProductSchema);
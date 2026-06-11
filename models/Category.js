const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  emoji: { type: String, default: '🏷️' },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('Category', CategorySchema);

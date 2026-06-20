const mongoose = require('mongoose');

const OfflineSaleSchema = new mongoose.Schema({
  itemName: { type: String, required: true },
  qty: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true },
  note: { type: String, default: '' },
  date: { type: String, required: true },          // YYYY-MM-DD
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('OfflineSale', OfflineSaleSchema);

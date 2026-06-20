const mongoose = require('mongoose');

const CashEntrySchema = new mongoose.Schema({
  type: { type: String, enum: ['income', 'expense'], required: true },
  amount: { type: Number, required: true, min: 0 },
  description: { type: String, default: '' },
  date: { type: String, required: true },          // YYYY-MM-DD
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('CashEntry', CashEntrySchema);

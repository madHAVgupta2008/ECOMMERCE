const mongoose = require('mongoose');

const CashEntrySchema = new mongoose.Schema({
  type: { type: String, enum: ['income', 'expense', 'pending'], required: true },
  amount: { type: Number, required: true, min: 0 },
  description: { type: String, default: '' },
  date: { type: String, required: true },          // YYYY-MM-DD
  createdAt: { type: String, default: () => new Date().toISOString() },
  paidAt: { type: String, default: null }          // set when pending → income
});

module.exports = mongoose.model('CashEntry', CashEntrySchema);


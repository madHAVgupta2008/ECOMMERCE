const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, default: '' },
  address: { type: String, required: true },
  payment: { type: String, required: true },
  notes: { type: String, default: '' },

  items: [
    {
      id: String,
      name: String,
      price: Number,
      qty: Number,
      itemCode: { type: String, default: '' }
    }
  ],

  total: { type: Number, required: true },
  status: { type: String, default: 'New' },
  date: { type: String, default: '' },
  createdAt: { type: String, default: () => new Date().toISOString() },
  updatedAt: { type: String, default: null }
});

module.exports = mongoose.model('Order', OrderSchema);
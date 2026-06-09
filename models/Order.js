const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  id: String,
  name: String,
  phone: String,
  email: String,
  address: String,
  payment: String,
  notes: String,

  items: [
    {
      id: String,
      name: String,
      price: Number,
      qty: Number,
      itemCode: String
    }
  ],

  total: Number,
  status: String,
  date: String,
  createdAt: String,
  updatedAt: String
});

module.exports = mongoose.model('Order', OrderSchema);
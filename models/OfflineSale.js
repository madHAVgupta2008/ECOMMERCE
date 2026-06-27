const mongoose = require('mongoose');

const OfflineSaleItemSchema = new mongoose.Schema({
  itemCode:  { type: String, default: '' },   // empty for custom/unlisted products
  itemName:  { type: String, required: true },
  qty:       { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 }  // qty × unitPrice
}, { _id: false });

const OfflineSaleSchema = new mongoose.Schema({
  items:       { type: [OfflineSaleItemSchema], required: true },
  subTotal:    { type: Number, required: true },   // sum of all lineTotals
  discount:    { type: Number, default: 0 },        // discount amount entered by admin
  finalAmount: { type: Number, required: true },    // subTotal - discount (goes to revenue)
  note:        { type: String, default: '' },
  date:        { type: String, required: true },    // YYYY-MM-DD
  createdAt:   { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model('OfflineSale', OfflineSaleSchema);

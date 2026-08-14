const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve your HTML files from /public

// ── MongoDB Connection ──
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── Order Schema ──
const orderSchema = new mongoose.Schema({
  customerName:  { type: String, required: true },
  customerPhone: { type: String, required: true },
  customerEmail: { type: String, default: '' },
  address:       { type: String, required: true },
  city:          { type: String, required: true },
  landmark:      { type: String, default: '' },
  notes:         { type: String, default: '' },
  paymentMethod: { type: String, default: 'Cash on Delivery' },
  orderSummary:  { type: Array, default: [] },
  subtotal:      { type: Number, default: 0 },
  shipping:      { type: Number, default: 200 },
  total:         { type: Number, required: true },
  status:        { type: String, default: 'pending', enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] },
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

// ── Product Schema ──
const productSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  desc:     { type: String, default: '' },
  price:    { type: Number, required: true },
  category: { type: String, default: 'Kitchen' },
  badge:    { type: String, default: '' },
  image:    { type: String, default: '' },
  active:   { type: Boolean, default: true },
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

// ═══════════════════════════════
//  ORDER ROUTES
// ═══════════════════════════════

// POST /api/orders — place a new order
app.post('/api/orders', async (req, res) => {
  try {
    const order = new Order(req.body);
    await order.save();
    console.log(`📦 New order from ${order.customerName} — PKR ${order.total}`);
    res.status(201).json({ success: true, orderId: order._id });
  } catch (err) {
    console.error('Order error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/orders — get all orders (admin)
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:id — get single order
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id — update order status
app.patch('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/orders/:id — delete an order
app.delete('/api/orders/:id', async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
//  PRODUCT ROUTES
// ═══════════════════════════════

// GET /api/products — get all active products
app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { active: true };
    if (category) filter.category = category;
    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products — add a product (admin)
app.post('/api/products', async (req, res) => {
  try {
    const product = new Product(req.body);
    await product.save();
    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/products/:id — update a product (admin)
app.patch('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id — delete a product (admin)
app.delete('/api/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats route ──
app.get('/api/stats', async (req, res) => {
  try {
    const [totalOrders, products, pendingOrders, revenueData] = await Promise.all([
      Order.countDocuments(),
      Product.countDocuments({ active: true }),
      Order.countDocuments({ status: 'pending' }),
      Order.aggregate([{ $group: { _id: null, total: { $sum: '$total' } } }]),
    ]);
    res.json({
      totalOrders,
      products,
      pendingOrders,
      revenue: revenueData[0]?.total || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Start server ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
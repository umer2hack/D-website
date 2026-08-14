const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { google } = require('googleapis');

dotenv.config();

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '2mb' })); // bulk product payloads are JSON-only (no image bytes), but bumped just in case
app.use(express.static('public')); // serve your HTML files from /public

// ── MongoDB Connection ──
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── Google Sheets Setup ──
// Reads credentials from .env — never hardcode these values here.
const sheetsAuth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Appends one order as a new row. Columns match your sheet headers:
// Date, Order ID, Customer Name, Phone Number, City, Address, Landmark, Payment Method, Total Amount
async function appendOrderToSheet(order) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:I', // change 'Sheet1' if your tab has a different name
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date(order.createdAt || Date.now()).toLocaleString(),
          order._id.toString(),
          order.customerName,
          order.customerPhone,
          order.city,
          order.address,
          order.landmark || '',
          order.paymentMethod,
          order.total,
        ]],
      },
    });
    console.log(`📝 Order ${order._id} written to Google Sheet`);
  } catch (err) {
    // We log but never throw — a Sheets failure should not block the order itself
    console.error('❌ Google Sheets append error:', err.message);
  }
}

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
  image:    { type: String, default: '' }, // Cloudinary secure_url — uploaded directly from the browser
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

    // Fire-and-forget: don't make the customer wait on Sheets before getting their confirmation
    appendOrderToSheet(order);

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

// POST /api/products — add a single product (admin)
app.post('/api/products', async (req, res) => {
  try {
    const product = new Product(req.body);
    await product.save();
    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/products/bulk — bulk-insert products (admin bulk upload)
// Expects: { products: [ { name, desc, price, category, badge, image }, ... ] }
// Images are uploaded to Cloudinary client-side before this call — this route
// only ever receives lightweight JSON, keeping load off this server.
// IMPORTANT: this route must be declared before any "/:id" routes below it,
// otherwise Express will try to match "bulk" as an :id and 404/500 will follow.
app.post('/api/products/bulk', async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ success: false, error: 'No products provided' });
    }
    // ordered: false — keeps inserting the rest even if one row fails validation
    const inserted = await Product.insertMany(products, { ordered: false });
    res.status(201).json({ success: true, count: inserted.length });
  } catch (err) {
    console.error('Bulk insert error:', err);
    // insertMany with ordered:false throws even on partial success — report what we can
    const insertedCount = err?.insertedDocs?.length || err?.result?.insertedCount || 0;
    res.status(insertedCount > 0 ? 201 : 500).json({
      success: insertedCount > 0,
      count: insertedCount,
      error: err.message,
    });
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
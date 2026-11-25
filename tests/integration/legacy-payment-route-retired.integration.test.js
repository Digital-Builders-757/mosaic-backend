const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startHarness, resetDatabase, stopHarness, getApp } = require('./setup/harness');
const { createAgent } = require('./helpers/client');
const {
  registerAndVerify,
  login,
  seedApprovedBusiness,
  seedPublishedProduct,
} = require('./helpers/factories');
const { setStripeShouldFail } = require('./helpers/providerStubs');
const User = require('../../models/User');
const Order = require('../../models/Order');
const ProductVariant = require('../../models/ProductVariant');

// The legacy client-driven PaymentIntent route (metadata only {orderId}, no
// Connect transfer) is retired. Every Express-equivalent spelling must miss the
// router entirely, so neither an anonymous nor an authenticated buyer can mint a
// PaymentIntent outside the canonical, gated POST /api/orders/initiate flow.
const LEGACY_PATHS = [
  '/api/payments/create-payment-intent',
  '/api/payments/create-payment-intent/',
  '/API/PAYMENTS/CREATE-PAYMENT-INTENT',
  '/Api/Payments/Create-Payment-Intent/',
];
const RETIRED_STATUSES = [404, 405];

test.before(() => startHarness({ transactions: true }));
test.afterEach(async () => {
  setStripeShouldFail(false);
  await resetDatabase();
});
test.after(() => stopHarness());

async function snapshot() {
  const result = {};
  for (const collection of Object.values(mongoose.connection.collections)) {
    result[collection.collectionName] = await collection.find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.stringify(result);
}

async function seedCheckout() {
  const vendorAgent = createAgent(getApp());
  const vendor = await registerAndVerify(vendorAgent, { role: 'business_owner' });
  const owner = await User.findOne({ email: vendor.email });
  const business = await seedApprovedBusiness(owner, {
    chargesEnabled: true,
    capabilities: { transfers: 'active' },
  });
  const product = await seedPublishedProduct(business, owner);
  const variant = await ProductVariant.create({
    productId: product._id,
    businessId: business._id,
    ownerId: owner._id,
    isPublished: true,
    attributes: { size: 'M' },
    sku: `LEGACY-RETIRED-${Date.now()}`,
    price: 20,
    stock: 10,
    shipping: { standard: 5, overnight: 12, local: 2 },
  });
  const agent = createAgent(getApp());
  const buyer = await registerAndVerify(agent, { role: 'customer' });
  await login(agent, buyer.email, buyer.password);
  const body = {
    items: [{
      productId: String(product._id),
      variantId: String(variant._id),
      size: 'M',
      quantity: 1,
    }],
    shippingAddress: {
      fullName: 'Buyer',
      phone: '1234567890',
      addressLine1: '1 Main St',
      state: 'GA',
    },
    selectedDeliverySpeed: 'standard',
  };
  return { agent, body };
}

test('anonymous POST to every legacy payment-intent spelling returns 404/405', async () => {
  const anonymous = createAgent(getApp());
  for (const legacyPath of LEGACY_PATHS) {
    const res = await anonymous.post(legacyPath).send({});
    assert.ok(
      RETIRED_STATUSES.includes(res.status),
      `${legacyPath} returned ${res.status}; expected 404 or 405`
    );
  }
});

test('authenticated buyer cannot mint a legacy PaymentIntent or mutate an order', async () => {
  const { agent, body } = await seedCheckout();
  body.items[0].price = 20;
  const initiated = await agent.post('/api/orders/initiate').send(body);
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  const order = await Order.findOne({});
  assert.ok(order, 'canonical initiate must create an order');
  const canonicalPaymentId = order.paymentId;

  const before = await snapshot();
  // A handler that reached Stripe would now fail with 500; a retired route
  // never reaches a handler at all.
  setStripeShouldFail(true);
  for (const legacyPath of LEGACY_PATHS) {
    const res = await agent.post(legacyPath).send({ orderId: String(order._id), amount: 1 });
    assert.ok(
      RETIRED_STATUSES.includes(res.status),
      `${legacyPath} returned ${res.status}; expected 404 or 405`
    );
    assert.equal(res.body?.clientSecret, undefined);
  }
  assert.equal(await snapshot(), before, 'legacy path must leave every document unchanged');
  const after = await Order.findById(order._id);
  assert.equal(after.paymentId, canonicalPaymentId, 'legacy path must not overwrite the canonical PaymentIntent');
});

test('canonical buy-now-quote and initiate remain available after retirement', async () => {
  const anonymous = createAgent(getApp());
  const unauthenticated = await anonymous.post('/api/orders/initiate').send({});
  assert.equal(unauthenticated.status, 401);
  const unauthenticatedQuote = await anonymous.post('/api/orders/buy-now-quote').send({});
  assert.equal(unauthenticatedQuote.status, 401);

  const { agent, body } = await seedCheckout();
  const quote = await agent.post('/api/orders/buy-now-quote').send(body);
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.pricing.subtotal, 20);

  body.items[0].price = 20;
  const initiated = await agent.post('/api/orders/initiate').send(body);
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  assert.equal(initiated.body.totals.totalAmount, quote.body.pricing.totalAmount);
  assert.equal(initiated.body.clientSecret, 'pi_integration_test_secret');
  assert.ok(initiated.body.groupOrderId, 'canonical initiate keeps its groupOrderId contract');
});

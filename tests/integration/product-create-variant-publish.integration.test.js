const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startHarness, resetDatabase, stopHarness, getApp } = require('./setup/harness');
const { createAgent } = require('./helpers/client');
const { registerAndVerify, login, seedApprovedBusiness } = require('./helpers/factories');
const User = require('../../models/User');
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');

test.before(() => startHarness());
test.afterEach(() => resetDatabase());
test.after(() => stopHarness());

const priceOf = (product) => (product.price == null ? null : Number(product.price.toString()));

async function setupVendor() {
  const agent = createAgent(getApp());
  const vendor = await registerAndVerify(agent, { role: 'business_owner' });
  const user = await User.findOne({ email: vendor.email });
  const business = await seedApprovedBusiness(user);
  assert.equal((await login(agent, vendor.email, vendor.password)).status, 200);
  return { agent, user, business };
}

function createProduct(agent, business, { isPublished, variants }) {
  return agent.post('/api/product').send({
    title: 'Synthetic Create Variant Publish Product',
    description: 'Synthetic product for per-variant Published/Draft on create',
    categoryId: new mongoose.Types.ObjectId().toString(),
    subcategoryId: new mongoose.Types.ObjectId().toString(),
    businessId: business._id.toString(),
    coverImage: 'https://example.test/create-variant-publish.webp',
    isPublished,
    variants,
  });
}

async function variantBySku(productId, suffix) {
  return ProductVariant.findOne({ productId, sku: new RegExp(`${suffix}$`) });
}

test('create: a per-variant Draft is respected and does not set the card price', async () => {
  const { agent, business } = await setupVendor();
  const res = await createProduct(agent, business, {
    isPublished: true,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-A', price: 20, stock: 2 },
      { attributes: { Size: 'B' }, sku: 'SYN-CVP-B', price: 8, stock: 2, isPublished: false },
      { attributes: { Size: 'C' }, sku: 'SYN-CVP-C', price: 30, stock: 2, isPublished: true },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const productId = res.body.product._id;

  assert.equal((await variantBySku(productId, 'SYN-CVP-A')).isPublished, true);
  assert.equal((await variantBySku(productId, 'SYN-CVP-B')).isPublished, false);
  assert.equal((await variantBySku(productId, 'SYN-CVP-C')).isPublished, true);

  const stored = await Product.findById(productId);
  assert.equal(stored.isPublished, true);
  // Live (published) variants only: A $20 is the lowest, Draft B $8 is not.
  assert.equal(priceOf(stored), 20);
  assert.equal(Number(res.body.product.price.$numberDecimal), 20);
});

test('create: publish request with every variant Draft creates the product unpublished', async () => {
  const { agent, business } = await setupVendor();
  const res = await createProduct(agent, business, {
    isPublished: true,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-DA', price: 20, stock: 2, isPublished: false },
      { attributes: { Size: 'B' }, sku: 'SYN-CVP-DB', price: 12, stock: 2, isPublished: false },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const productId = res.body.product._id;

  const stored = await Product.findById(productId);
  assert.equal(stored.isPublished, false);
  assert.equal(res.body.product.isPublished, false);
  assert.equal((await variantBySku(productId, 'SYN-CVP-DA')).isPublished, false);
  assert.equal((await variantBySku(productId, 'SYN-CVP-DB')).isPublished, false);
  // No live variant: the stored price falls back to all non-deleted variants.
  assert.equal(priceOf(stored), 12);
});

test('create: legacy payload without per-variant flags is unchanged', async () => {
  const { agent, business } = await setupVendor();

  const published = await createProduct(agent, business, {
    isPublished: true,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-PA', price: 20, stock: 2 },
      { attributes: { Size: 'B' }, sku: 'SYN-CVP-PB', price: 10, stock: 2 },
    ],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const publishedId = published.body.product._id;
  assert.equal((await Product.findById(publishedId)).isPublished, true);
  assert.equal((await variantBySku(publishedId, 'SYN-CVP-PA')).isPublished, true);
  assert.equal((await variantBySku(publishedId, 'SYN-CVP-PB')).isPublished, true);
  assert.equal(priceOf(await Product.findById(publishedId)), 10);

  const draft = await createProduct(agent, business, {
    isPublished: false,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-UA', price: 20, stock: 2 },
      { attributes: { Size: 'B' }, sku: 'SYN-CVP-UB', price: 10, stock: 2 },
    ],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const draftId = draft.body.product._id;
  assert.equal((await Product.findById(draftId)).isPublished, false);
  assert.equal((await variantBySku(draftId, 'SYN-CVP-UA')).isPublished, false);
  assert.equal((await variantBySku(draftId, 'SYN-CVP-UB')).isPublished, false);
  assert.equal(priceOf(await Product.findById(draftId)), 10);
});

test('create: publish where the only priced variant is Draft is rejected and nothing is kept', async () => {
  const { agent, business } = await setupVendor();
  const res = await createProduct(agent, business, {
    isPublished: true,
    variants: [
      { attributes: { Size: 'Z' }, sku: 'SYN-CVP-ZERO', price: 0, stock: 1 },
      { attributes: { Size: 'P' }, sku: 'SYN-CVP-PRICED', price: 15, stock: 1, isPublished: false },
    ],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'LISTING_PRICE_REQUIRED');
  assert.equal(await Product.countDocuments({ businessId: business._id, isDeleted: { $ne: true } }), 0);
  assert.equal(await ProductVariant.countDocuments({ businessId: business._id }), 0);
});

test('create: string publish flags behave like booleans', async () => {
  const { agent, business } = await setupVendor();
  const res = await createProduct(agent, business, {
    isPublished: 'true',
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-SA', price: 20, stock: 2, isPublished: 'true' },
      { attributes: { Size: 'B' }, sku: 'SYN-CVP-SB', price: 8, stock: 2, isPublished: 'false' },
      { attributes: { Size: 'C' }, sku: 'SYN-CVP-SC', price: 30, stock: 2 },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const productId = res.body.product._id;
  assert.equal((await Product.findById(productId)).isPublished, true);
  assert.equal((await variantBySku(productId, 'SYN-CVP-SA')).isPublished, true);
  assert.equal((await variantBySku(productId, 'SYN-CVP-SB')).isPublished, false);
  assert.equal((await variantBySku(productId, 'SYN-CVP-SC')).isPublished, true);
  assert.equal(priceOf(await Product.findById(productId)), 20);

  // Product-level 'false' string creates a draft (Boolean('false') used to publish).
  const draft = await createProduct(agent, business, {
    isPublished: 'false',
    variants: [{ attributes: { Size: 'A' }, sku: 'SYN-CVP-SFA', price: 20, stock: 2 }],
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal((await Product.findById(draft.body.product._id)).isPublished, false);
  assert.equal((await variantBySku(draft.body.product._id, 'SYN-CVP-SFA')).isPublished, false);
});

test('create: unrecognised publish values fall back (product draft; variant follows product)', async () => {
  const { agent, business } = await setupVendor();

  // Product level: the create route's isBoolean validator already rejects
  // non-boolean strings before the controller (pre-existing behaviour).
  const rejected = await createProduct(agent, business, {
    isPublished: 'yes',
    variants: [{ attributes: { Size: 'A' }, sku: 'SYN-CVP-GX', price: 20, stock: 2 }],
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(await Product.countDocuments({ businessId: business._id }), 0);

  // A variant-level unrecognised value on a draft create: variant stays Draft.
  const res = await createProduct(agent, business, {
    isPublished: false,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-GA', price: 20, stock: 2, isPublished: 'nope' },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const productId = res.body.product._id;
  assert.equal((await Product.findById(productId)).isPublished, false);
  assert.equal((await variantBySku(productId, 'SYN-CVP-GA')).isPublished, false);

  const published = await createProduct(agent, business, {
    isPublished: true,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-CVP-GB', price: 20, stock: 2, isPublished: 'maybe' },
    ],
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal((await Product.findById(published.body.product._id)).isPublished, true);
  assert.equal((await variantBySku(published.body.product._id, 'SYN-CVP-GB')).isPublished, true);
});

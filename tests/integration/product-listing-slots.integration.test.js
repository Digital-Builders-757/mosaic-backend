// Listing-slot rule (owner decision #514): one product uses one slot. Variants
// never count, and a no-option product uses one slot despite its default
// variant. Synthetic data, in-memory Mongo.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { startHarness, resetDatabase, stopHarness } = require('./setup/harness');

let Product;
let ProductVariant;
let SubscriptionPlan;
let User;
let factories;
let controller;

test.before(async () => {
  await startHarness();
  Product = require('../../models/Product');
  ProductVariant = require('../../models/ProductVariant');
  SubscriptionPlan = require('../../models/SubscriptionPlan');
  User = require('../../models/User');
  factories = require('./helpers/factories');
  controller = require('../../controllers/productController');
  await Product.init();
  await ProductVariant.init();
});

const savedOverride = process.env.PRODUCT_LISTING_LIMIT_OVERRIDE;
test.afterEach(async () => {
  if (savedOverride === undefined) delete process.env.PRODUCT_LISTING_LIMIT_OVERRIDE;
  else process.env.PRODUCT_LISTING_LIMIT_OVERRIDE = savedOverride;
  await resetDatabase();
});

test.after(async () => {
  await stopHarness();
});

async function seedVendor(productListings) {
  // Non-production resolves to unlimited unless overridden; pin the cap so
  // the counting rule is what is under test.
  process.env.PRODUCT_LISTING_LIMIT_OVERRIDE = String(productListings);
  await SubscriptionPlan.create({
    name: 'Launch Plan',
    price: 0,
    limits: { productListings, serviceListings: 1, foodListings: 1, imageLimit: 5, videoLimit: 0 },
  });
  const user = await User.create({
    name: 'Synthetic Slot Vendor',
    email: `slots-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    mobile: `+1415555${String(Date.now()).slice(-4)}`,
    passwordHash: await bcrypt.hash('Synthetic123!', 4),
    role: 'business_owner',
    isOtpVerified: true,
  });
  const business = await factories.seedApprovedBusiness(user);
  return { user, business };
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

let skuSeq = 0;
const variant = (size) => ({ attributes: { Size: size }, sku: `SLOT-${++skuSeq}`, price: 20, stock: 2 });

async function createProduct(user, business, variants, title) {
  const out = res();
  await controller.createProductWithVariants({
    user: { _id: user._id },
    body: {
      title,
      description: 'Synthetic product',
      businessId: String(business._id),
      categoryId: String(new mongoose.Types.ObjectId()),
      subcategoryId: String(new mongoose.Types.ObjectId()),
      coverImage: 'https://example.test/cover.webp',
      galleryImages: ['https://example.test/g1.webp'],
      variants,
      isPublished: false,
    },
  }, out);
  return out;
}

async function addVariants(user, productId, variants) {
  const out = res();
  await controller.addVariants({ user: { _id: user._id }, params: { productId: String(productId) }, body: { variants } }, out);
  return out;
}

test('a product with several variants uses one slot (cap 1 still allows it)', async () => {
  const { user, business } = await seedVendor(1);
  const created = await createProduct(user, business, [variant('S'), variant('M'), variant('L')], 'Three Sizes');
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(await Product.countDocuments({ businessId: business._id }), 1);
  assert.equal(await ProductVariant.countDocuments({ businessId: business._id }), 3);
});

test('a no-option product uses one slot: two of them fit a cap of 2', async () => {
  const { user, business } = await seedVendor(2);
  for (const title of ['Plain A', 'Plain B']) {
    const created = await createProduct(user, business, [{ attributes: {}, sku: `PLAIN-${title}`, price: 18, stock: 4 }], title);
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  }
  assert.equal(await Product.countDocuments({ businessId: business._id }), 2);
});

test('adding variants at the cap does not use another slot', async () => {
  const { user, business } = await seedVendor(1);
  const created = await createProduct(user, business, [variant('S')], 'At Cap');
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  const productId = created.body.product?._id || created.body.data?._id;
  assert.ok(productId, 'product id returned');

  const added = await addVariants(user, productId, [variant('M'), variant('L')]);
  assert.ok(added.statusCode < 300, `add variants at cap should succeed: ${added.statusCode} ${JSON.stringify(added.body)}`);
  assert.equal(await ProductVariant.countDocuments({ productId, isDeleted: false }), 3);
});

test('creating another product at the cap is blocked with a product-based message', async () => {
  const { user, business } = await seedVendor(1);
  assert.equal((await createProduct(user, business, [variant('S'), variant('M')], 'First')).statusCode, 201);

  const blocked = await createProduct(user, business, [variant('L')], 'Second');
  assert.equal(blocked.statusCode, 403);
  assert.match(String(blocked.body.error), /Your plan allows 1 products\./);
  assert.doesNotMatch(String(blocked.body.error), /variant/);
  assert.equal(await Product.countDocuments({ businessId: business._id }), 1);
});

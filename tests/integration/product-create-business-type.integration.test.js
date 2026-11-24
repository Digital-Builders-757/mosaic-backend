// Add Product with several businesses: a goods listing can only be created
// under a product business. Service and food businesses are rejected before
// anything is written. Synthetic data, in-memory Mongo.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { startHarness, resetDatabase, stopHarness } = require('./setup/harness');

let Product;
let ProductVariant;
let User;
let factories;
let controller;

test.before(async () => {
  await startHarness();
  Product = require('../../models/Product');
  ProductVariant = require('../../models/ProductVariant');
  User = require('../../models/User');
  factories = require('./helpers/factories');
  controller = require('../../controllers/productController');
  await Product.init();
  await ProductVariant.init();
});

test.afterEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await stopHarness();
});

async function seedOwner() {
  return User.create({
    name: 'Synthetic Multi-Business Vendor',
    email: `multi-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    mobile: `+1415555${String(Date.now()).slice(-4)}`,
    passwordHash: await bcrypt.hash('Synthetic123!', 4),
    role: 'business_owner',
    isOtpVerified: true,
  });
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
async function createProduct(user, business, title) {
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
      variants: [{ attributes: {}, sku: `BT-${++skuSeq}`, price: 12, stock: 3 }],
      isPublished: false,
    },
  }, out);
  return out;
}

for (const listingType of ['service', 'food']) {
  test(`a ${listingType} business cannot create a product listing`, async () => {
    const user = await seedOwner();
    const business = await factories.seedApprovedBusiness(user, {
      listingType,
      businessName: `Synthetic ${listingType} business`,
    });

    const out = await createProduct(user, business, `Goods under ${listingType}`);
    assert.equal(out.statusCode, 403, JSON.stringify(out.body));
    assert.equal(out.body.code, 'PRODUCT_BUSINESS_TYPE_MISMATCH');
    assert.equal(await Product.countDocuments({ businessId: business._id }), 0);
    assert.equal(await ProductVariant.countDocuments({ businessId: business._id }), 0);
  });
}

test('with a service and a product business, the product lands on the selected product business only', async () => {
  const user = await seedOwner();
  const service = await factories.seedApprovedBusiness(user, {
    listingType: 'service',
    businessName: 'Synthetic service business',
  });
  const goods = await factories.seedApprovedBusiness(user, {
    listingType: 'product',
    businessName: 'Synthetic goods business',
  });

  const created = await createProduct(user, goods, 'Mug');
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(await Product.countDocuments({ businessId: goods._id }), 1);
  assert.equal(await Product.countDocuments({ businessId: service._id }), 0);

  const rejected = await createProduct(user, service, 'Mug under service');
  assert.equal(rejected.statusCode, 403);
  assert.equal(await Product.countDocuments({ ownerId: user._id }), 1);
});

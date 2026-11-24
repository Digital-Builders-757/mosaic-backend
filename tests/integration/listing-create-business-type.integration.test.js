// Service and food listings can only be created under a business of the same
// listing type, matching the product rule (PRODUCT_BUSINESS_TYPE_MISMATCH).
// A vendor with several businesses must not publish a service or food listing
// on a goods storefront. Synthetic data, in-memory Mongo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, resetDatabase, stopHarness, getApp } = require('./setup/harness');
const { createAgent } = require('./helpers/client');
const {
  registerAndVerify,
  login,
  seedApprovedBusiness,
  seedServiceCategories,
} = require('./helpers/factories');
const User = require('../../models/User');
const Service = require('../../models/Service');
const Food = require('../../models/Food');
const FoodCategory = require('../../models/FoodCategory');
const FoodSubcategory = require('../../models/FoodSubcategory');

test.before(async () => { await startHarness(); });
test.afterEach(async () => { await resetDatabase(); });
test.after(async () => { await stopHarness(); });

async function vendorWith(listingTypes) {
  const agent = createAgent(getApp());
  const vendor = await registerAndVerify(agent, { role: 'business_owner' });
  const user = await User.findOne({ email: vendor.email });
  const businesses = {};
  for (const listingType of listingTypes) {
    businesses[listingType] = await seedApprovedBusiness(user, {
      listingType,
      businessName: `Synthetic ${listingType} business`,
    });
  }
  assert.equal((await login(agent, vendor.email, vendor.password)).status, 200);
  return { agent, businesses };
}

async function servicePayload(business) {
  const { category, subcategory } = await seedServiceCategories();
  return {
    title: 'Synthetic Hair Styling',
    description: 'Synthetic service for the business-type guard',
    price: 45,
    duration: '60',
    services: [{ name: 'Basic Cut' }],
    businessId: String(business._id),
    categoryId: String(category._id),
    subcategoryId: String(subcategory._id),
    isPublished: false,
  };
}

async function foodPayload(business) {
  const category = await FoodCategory.create({ name: `Guard food category ${Date.now()}` });
  const subcategory = await FoodSubcategory.create({
    name: `Guard food subcategory ${Date.now()}`,
    category: category._id,
  });
  return {
    title: 'Synthetic Jollof Rice',
    description: 'Synthetic food for the business-type guard',
    price: 25,
    businessId: String(business._id),
    categoryId: String(category._id),
    subcategoryId: String(subcategory._id),
    coverImage: 'https://example.test/food.webp',
    images: ['https://example.test/g1.webp'],
    isPublished: false,
  };
}

for (const listingType of ['product', 'food']) {
  test(`a ${listingType} business cannot create a service listing (both create routes)`, async () => {
    const { agent, businesses } = await vendorWith([listingType]);
    const payload = await servicePayload(businesses[listingType]);

    for (const route of ['/api/service/', '/api/service/parent']) {
      const res = await agent.post(route).send(payload);
      assert.equal(res.status, 403, `${route} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'SERVICE_BUSINESS_TYPE_MISMATCH');
    }
    assert.equal(await Service.countDocuments(), 0);
  });
}

for (const listingType of ['product', 'service']) {
  test(`a ${listingType} business cannot create a food listing`, async () => {
    const { agent, businesses } = await vendorWith([listingType]);
    const res = await agent.post('/api/food/add-food').send(await foodPayload(businesses[listingType]));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'FOOD_BUSINESS_TYPE_MISMATCH');
    assert.equal(await Food.countDocuments(), 0);
  });
}

test('with a product and a service business, the service lands on the service business only', async () => {
  const { agent, businesses } = await vendorWith(['product', 'service']);

  const rejected = await agent.post('/api/service/').send(await servicePayload(businesses.product));
  assert.equal(rejected.status, 403);
  assert.equal(await Service.countDocuments(), 0);

  const created = await agent.post('/api/service/').send(await servicePayload(businesses.service));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(await Service.countDocuments({ businessId: businesses.service._id }), 1);
  assert.equal(await Service.countDocuments({ businessId: businesses.product._id }), 0);
});

test('a food business still creates its food listing', async () => {
  const { agent, businesses } = await vendorWith(['product', 'food']);
  const created = await agent.post('/api/food/add-food').send(await foodPayload(businesses.food));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(await Food.countDocuments({ businessId: businesses.food._id }), 1);
  assert.equal(await Food.countDocuments({ businessId: businesses.product._id }), 0);
});

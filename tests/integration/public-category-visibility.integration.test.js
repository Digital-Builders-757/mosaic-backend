const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startHarness,
  resetDatabase,
  stopHarness,
  getApp,
} = require('./setup/harness');
const { createAgent } = require('./helpers/client');
const {
  createAdminDirect,
  login,
  registerAndVerify,
} = require('./helpers/factories');
const ProductCategory = require('../../models/ProductCategory');
const ServiceCategory = require('../../models/ServiceCategory');
const FoodCategory = require('../../models/FoodCategory');
const ProductSubcategory = require('../../models/ProductSubcategory');
const ServiceSubcategory = require('../../models/ServiceSubcategory');
const FoodSubcategory = require('../../models/FoodSubcategory');

test.before(async () => {
  await startHarness();
});

test.afterEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await stopHarness();
});

test('public category endpoints hide legacy invalid and hidden categories', async () => {
  const agent = createAgent(getApp());

  await ProductCategory.create({ name: 'Electronics' });
  await ServiceCategory.create({ name: 'Home Cleaning' });
  await FoodCategory.create({ name: 'Food & Grocery' });
  await ProductCategory.create({ name: 'Office Supplies', hidden: true });
  await ServiceCategory.create({ name: 'Window Washing', isActive: false });
  await FoodCategory.create({ name: 'Prepared Meals', status: 'hidden' });

  await ProductCategory.collection.insertMany([
    { name: 'gcgjgjgg', slug: 'gcgjgjgg' },
    { name: 'vvvvv', slug: 'vvvvv' },
    { name: 'v v v v', slug: 'v-v-v-v' },
  ]);
  await ServiceCategory.collection.insertOne({ name: 'gcgjgjgg', slug: 'gcgjgjgg' });
  await FoodCategory.collection.insertOne({ name: 'vvvvv', slug: 'vvvvv' });

  const all = await agent.get('/api/categories');
  assert.equal(all.status, 200);
  assertNames(all.body.data.productCategories, {
    includes: ['Electronics'],
    excludes: ['gcgjgjgg', 'vvvvv', 'v v v v', 'Office Supplies'],
  });
  assertNames(all.body.data.serviceCategories, {
    includes: ['Home Cleaning'],
    excludes: ['gcgjgjgg', 'Window Washing'],
  });
  assertNames(all.body.data.foodCategories, {
    includes: ['Food & Grocery'],
    excludes: ['vvvvv', 'Prepared Meals'],
  });

  const products = await agent.get('/api/categories/products');
  assert.equal(products.status, 200);
  assertNames(products.body.data.productCategories, {
    includes: ['Electronics'],
    excludes: ['gcgjgjgg', 'vvvvv', 'v v v v', 'Office Supplies'],
  });

  const services = await agent.get('/api/categories/services');
  assert.equal(services.status, 200);
  assertNames(services.body.data.serviceCategories, {
    includes: ['Home Cleaning'],
    excludes: ['gcgjgjgg', 'Window Washing'],
  });

  const foods = await agent.get('/api/categories/foods');
  assert.equal(foods.status, 200);
  assertNames(foods.body.data.foodCategories, {
    includes: ['Food & Grocery'],
    excludes: ['vvvvv', 'Prepared Meals'],
  });

  const legacyProducts = await agent.get('/api/admin/category/product');
  assert.equal(legacyProducts.status, 200);
  assertNames(legacyProducts.body.data, {
    includes: ['Electronics'],
    excludes: ['gcgjgjgg', 'vvvvv', 'v v v v', 'Office Supplies'],
  });

  const legacyServices = await agent.get('/api/admin/category/service');
  assert.equal(legacyServices.status, 200);
  assertNames(legacyServices.body.categories, {
    includes: ['Home Cleaning'],
    excludes: ['gcgjgjgg', 'Window Washing'],
  });

  const legacyFoods = await agent.get('/api/admin/category/food');
  assert.equal(legacyFoods.status, 200);
  assertNames(legacyFoods.body.data, {
    includes: ['Food & Grocery'],
    excludes: ['vvvvv', 'Prepared Meals'],
  });
});

test('admin category creation rejects obvious test names', async () => {
  const { email, password } = await createAdminDirect();
  const adminAgent = createAgent(getApp());
  await login(adminAgent, email, password);

  const product = await adminAgent
    .post('/api/admin/category/product')
    .send({ name: 'gcgjgjgg' });
  assert.equal(product.status, 400);
  assert.match(product.body.message, /test data|reserved/i);

  const service = await adminAgent
    .post('/api/admin/category/service')
    .send({ name: 'vvvvv' });
  assert.equal(service.status, 400);
  assert.match(service.body.message, /placeholder|test data|reserved/i);

  const food = await adminAgent
    .post('/api/admin/category/food')
    .send({ name: 'v v v v' });
  assert.equal(food.status, 400);
  assert.match(food.body.message, /placeholder|test data|reserved/i);
});

async function seedSubcategoryVisibilityFixtures() {
  const publicParent = await ProductCategory.create({ name: 'Electronics' });
  const hiddenParent = await ProductCategory.create({ name: 'Office Supplies', hidden: true });
  const { insertedIds } = await ProductCategory.collection.insertMany([
    { name: 'Garden Tools', slug: 'garden-tools', status: 'archived' },
    { name: 'Party Rentals', slug: 'party-rentals', isDeleted: true },
    { name: 'gcgjgjgg', slug: 'gcgjgjgg' },
  ]);
  const [archivedParentId, deletedParentId, testParentId] = Object.values(insertedIds);

  await ProductSubcategory.create({ name: 'Laptop Cables', category: publicParent._id });
  await ProductSubcategory.create({ name: 'Laptop Stands', category: publicParent._id });
  await ProductSubcategory.create({ name: 'Laptop Paper', category: hiddenParent._id });
  await ProductSubcategory.create({ name: 'Laptop Shears', category: archivedParentId });
  await ProductSubcategory.create({ name: 'Laptop Tents', category: deletedParentId });
  await ProductSubcategory.create({ name: 'Laptop Junk', category: testParentId });

  return { publicParent, hiddenParent };
}

const HIDDEN_PARENT_CHILDREN = ['Laptop Paper', 'Laptop Shears', 'Laptop Tents', 'Laptop Junk'];

test('GET /api/sub-categories without a category only returns children of public parents', async () => {
  const agent = createAgent(getApp());
  await seedSubcategoryVisibilityFixtures();

  const unfiltered = await agent.get('/api/sub-categories');
  assert.equal(unfiltered.status, 200);
  assertNames(unfiltered.body, {
    includes: ['Laptop Cables', 'Laptop Stands'],
    excludes: HIDDEN_PARENT_CHILDREN,
  });
  assert.equal(unfiltered.body.length, 2);

  const searched = await agent.get('/api/sub-categories').query({ q: 'laptop' });
  assert.equal(searched.status, 200);
  assertNames(searched.body, {
    includes: ['Laptop Cables', 'Laptop Stands'],
    excludes: HIDDEN_PARENT_CHILDREN,
  });
  assert.equal(searched.body.length, 2);

  const narrowed = await agent.get('/api/sub-categories').query({ q: 'stand' });
  assert.equal(narrowed.status, 200);
  assert.deepEqual(narrowed.body.map((sub) => sub.name), ['Laptop Stands']);
});

test('GET /api/sub-categories filtered by a public category is unchanged', async () => {
  const agent = createAgent(getApp());
  const { publicParent, hiddenParent } = await seedSubcategoryVisibilityFixtures();

  const bySlug = await agent.get('/api/sub-categories').query({ categorySlug: publicParent.slug });
  assert.equal(bySlug.status, 200);
  assert.deepEqual(bySlug.body.map((sub) => sub.name), ['Laptop Cables', 'Laptop Stands']);
  for (const sub of bySlug.body) {
    assert.equal(String(sub.category), String(publicParent._id));
  }

  const byId = await agent
    .get('/api/sub-categories')
    .query({ categoryId: String(publicParent._id) });
  assert.equal(byId.status, 200);
  assert.deepEqual(byId.body.map((sub) => sub.name), ['Laptop Cables', 'Laptop Stands']);

  const byIdAndQ = await agent
    .get('/api/sub-categories')
    .query({ categoryId: String(publicParent._id), q: 'cable' });
  assert.equal(byIdAndQ.status, 200);
  assert.deepEqual(byIdAndQ.body.map((sub) => sub.name), ['Laptop Cables']);

  const hiddenSlug = await agent
    .get('/api/sub-categories')
    .query({ categorySlug: hiddenParent.slug });
  assert.equal(hiddenSlug.status, 404);

  const hiddenId = await agent
    .get('/api/sub-categories')
    .query({ categoryId: String(hiddenParent._id) });
  assert.equal(hiddenId.status, 404);
});

test('admin subcategory list routes require an authenticated admin', async () => {
  const productParent = await ProductCategory.create({ name: 'Electronics' });
  const serviceParent = await ServiceCategory.create({ name: 'Home Cleaning' });
  const foodParent = await FoodCategory.create({ name: 'Food & Grocery' });
  await ProductSubcategory.create({ name: 'Cables', category: productParent._id });
  await ServiceSubcategory.create({ name: 'Deep Clean', category: serviceParent._id });
  await FoodSubcategory.create({ name: 'Produce', category: foodParent._id });

  const routes = [
    ['/api/admin/category/product-subcategory', 'Cables'],
    ['/api/admin/category/service-subcategory', 'Deep Clean'],
    ['/api/admin/category/food-subcategory', 'Produce'],
  ];

  const anonymous = createAgent(getApp());
  for (const [route] of routes) {
    const res = await anonymous.get(route);
    assert.equal(res.status, 401, `${route} must reject anonymous GET`);
  }

  const customer = createAgent(getApp());
  const { email: customerEmail, password: customerPassword } = await registerAndVerify(customer, {
    role: 'customer',
  });
  await login(customer, customerEmail, customerPassword);
  for (const [route] of routes) {
    const res = await customer.get(route);
    assert.equal(res.status, 403, `${route} must reject non-admin GET`);
  }

  const { email, password } = await createAdminDirect();
  const adminAgent = createAgent(getApp());
  await login(adminAgent, email, password);
  for (const [route, expectedName] of routes) {
    const res = await adminAgent.get(route);
    assert.equal(res.status, 200, `${route} must allow admin GET`);
    assert.equal(res.body.success, true);
    assertNames(res.body.data, { includes: [expectedName] });
  }
});

function assertNames(categories, { includes = [], excludes = [] }) {
  assert.ok(Array.isArray(categories));
  const names = categories.map((category) => category.name);

  for (const expected of includes) {
    assert.ok(names.includes(expected), `${expected} should be public`);
  }

  for (const blocked of excludes) {
    assert.equal(names.includes(blocked), false, `${blocked} should be hidden`);
  }
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { startHarness, resetDatabase, stopHarness, getApp } = require('./setup/harness');
const { createAgent } = require('./helpers/client');
const {
  registerAndVerify,
  seedApprovedBusiness,
  seedPublishedProduct,
} = require('./helpers/factories');
const User = require('../../models/User');
const Product = require('../../models/Product');

const COVER = 'https://example.test/synthetic-gallery/cover.png';
const GALLERY = [
  'https://example.test/synthetic-gallery/second-saved.jpg',
  'https://example.test/synthetic-gallery/first-saved.jpg',
];

test.before(async () => {
  await startHarness();
});

test.afterEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await stopHarness();
});

async function seedGalleryProduct() {
  const agent = createAgent(getApp());
  const vendor = await registerAndVerify(agent, { role: 'business_owner' });
  const user = await User.findOne({ email: vendor.email });
  const business = await seedApprovedBusiness(user);
  const product = await seedPublishedProduct(business, user);
  await Product.updateOne({ _id: product._id }, { coverImage: COVER, galleryImages: GALLERY });
  return product;
}

test('GET /api/public/product/:id returns the product gallery in saved order', async () => {
  const product = await seedGalleryProduct();

  const res = await createAgent(getApp()).get(`/api/public/product/${product._id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;

  assert.equal(data.coverImage, COVER);
  assert.deepEqual(data.galleryImages, GALLERY);
  assert.deepEqual(data.images, [COVER, ...GALLERY]);
  assert.equal(data.imageUrl, COVER);

  // Allowlisted DTO: owner-only fields still stay out of the public payload.
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'isDeleted'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(data, 'metaFields'), false);
});

test('draft, hidden and deleted gallery products still 404 on the public detail route', async () => {
  const product = await seedGalleryProduct();
  const anon = createAgent(getApp());

  for (const update of [{ isPublished: false }, { isActive: false }, { isDeleted: true }]) {
    await Product.collection.updateOne({ _id: product._id }, { $set: update });
    const res = await anon.get(`/api/public/product/${product._id}`);
    assert.equal(res.status, 404, `expected 404 for ${JSON.stringify(update)}`);
    assert.equal(res.body.data, undefined);
    await Product.collection.updateOne(
      { _id: product._id },
      { $set: { isPublished: true, isActive: true, isDeleted: false } }
    );
  }

  const visible = await anon.get(`/api/public/product/${product._id}`);
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.body.data.galleryImages, GALLERY);
});

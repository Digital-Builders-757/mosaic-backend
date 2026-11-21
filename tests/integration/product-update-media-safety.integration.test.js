// PUT /api/product/:id safety against a real MongoDB (synthetic data, no AWS).
//
// 1. Replacing a cover may only delete the old object when it is this vendor's
//    own upload (`products/<userId>/...` in AWS_S3_BUCKET), is no longer
//    referenced, and only after the product save succeeded.
// 2. A rejected publish must not delete variants; a request without a
//    `variants` array leaves variants untouched.
//
// S3 is never called: S3Client.prototype.send is mocked and records deletes.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { startHarness, resetDatabase, stopHarness } = require('./setup/harness');

const BUCKET = 'synthetic-product-bucket';
const REGION = 'us-east-1';
const S3_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`;

let Product;
let ProductVariant;
let SubscriptionPlan;
let User;
let factories;
let controller;
let previousEnv;
let seq = 0;

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
  previousEnv = { bucket: process.env.AWS_S3_BUCKET, region: process.env.AWS_REGION };
  process.env.AWS_S3_BUCKET = BUCKET;
  process.env.AWS_REGION = REGION;
});

test.afterEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  for (const [name, value] of [['AWS_S3_BUCKET', previousEnv.bucket], ['AWS_REGION', previousEnv.region]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await stopHarness();
});

async function seedVendor() {
  if (!(await SubscriptionPlan.exists({ name: 'Launch Plan' }))) {
    await SubscriptionPlan.create({
      name: 'Launch Plan',
      price: 0,
      limits: { productListings: 10, serviceListings: 1, foodListings: 1, imageLimit: 5, videoLimit: 0 },
    });
  }
  seq += 1;
  const user = await User.create({
    name: `Synthetic Vendor ${seq}`,
    email: `vendor-media-${seq}-${Date.now()}@example.test`,
    mobile: `+1415556${String(1000 + seq).slice(-4)}`,
    passwordHash: await bcrypt.hash('Synthetic123!', 4),
    role: 'business_owner',
    isOtpVerified: true,
  });
  const business = await factories.seedApprovedBusiness(user);
  return { user, business };
}

const ownUrl = (user, name) => `${S3_BASE}products/${user._id}/covers/1700000000000-${name}.webp`;
const variant = (sku, price = 20, size = 'M') => ({ attributes: { Size: size }, sku, price, stock: 2 });

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

async function createProduct(user, business, { coverImage, variants = [variant(`SKU-${seq}-${Date.now()}`)] } = {}) {
  const res = mockRes();
  await controller.createProductWithVariants({
    user: { _id: user._id },
    body: {
      title: 'Synthetic Product',
      description: 'Synthetic product',
      businessId: String(business._id),
      categoryId: String(new mongoose.Types.ObjectId()),
      subcategoryId: String(new mongoose.Types.ObjectId()),
      coverImage,
      galleryImages: [],
      variants,
      isPublished: false,
    },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return Product.findById(res.body.product._id);
}

async function updateProduct(user, productId, body) {
  const res = mockRes();
  await controller.updateProduct({ params: { productId: String(productId) }, user: { _id: user._id }, body }, res);
  return res;
}

async function updateVariant(user, productId, variantId, body) {
  const res = mockRes();
  await controller.updateVariant({
    params: { productId: String(productId), variantId: String(variantId) },
    user: { _id: user._id },
    body,
  }, res);
  return res;
}

// Records every S3 DeleteObject and the stored cover at the moment it is sent.
function recordS3Deletes(t, productId, variantId) {
  const deletes = [];
  t.mock.method(S3Client.prototype, 'send', async (command) => {
    assert.ok(command instanceof DeleteObjectCommand, 'only deletes are expected');
    const entry = { key: command.input.Key, bucket: command.input.Bucket };
    if (productId) entry.storedCover = (await Product.findById(productId).lean())?.coverImage;
    if (variantId) entry.storedImages = (await ProductVariant.findById(variantId).lean())?.images;
    deletes.push(entry);
    return {};
  });
  return deletes;
}

test('replacing a cover never deletes another vendor key or a non-owned URL', async (t) => {
  const { user: other } = await seedVendor();
  const { user, business } = await seedVendor();
  const deletes = recordS3Deletes(t);

  const notOwned = [
    ownUrl(other, 'other-vendor'),
    `${S3_BASE}products/${user._id}/../${other._id}/covers/x.webp`,
    `${S3_BASE}products/${user._id}/covers/%2e%2e/x.webp`,
    `${S3_BASE}vendor-onboarding/${user._id}/license.pdf`,
    `https://other-bucket.s3.${REGION}.amazonaws.com/products/${user._id}/covers/x.webp`,
    `https://res.cloudinary.com/demo/image/upload/products/${user._id}/covers/x.webp`,
  ];
  for (const [i, oldCover] of notOwned.entries()) {
    const product = await createProduct(user, business, { coverImage: oldCover });
    const res = await updateProduct(user, product._id, { coverImage: ownUrl(user, `new-${i}`) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal((await Product.findById(product._id)).coverImage, ownUrl(user, `new-${i}`));
  }
  assert.deepEqual(deletes, [], 'no storage object outside the vendor prefix is deleted');
});

test('own replaced cover is deleted only after the save, and not when still referenced', async (t) => {
  const { user, business } = await seedVendor();
  const shared = ownUrl(user, 'shared');
  const product = await createProduct(user, business, { coverImage: ownUrl(user, 'old') });
  const sibling = await createProduct(user, business, { coverImage: shared });
  const deletes = recordS3Deletes(t, product._id);

  const res = await updateProduct(user, product._id, { coverImage: shared });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(deletes, [{
    key: `products/${user._id}/covers/1700000000000-old.webp`,
    bucket: BUCKET,
    storedCover: shared, // the new cover was already saved when the delete ran
  }]);

  // `shared` is still the sibling's cover, so replacing it here keeps the object.
  deletes.length = 0;
  const again = await updateProduct(user, product._id, { coverImage: ownUrl(user, 'newest') });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(deletes, []);
  assert.equal((await Product.findById(sibling._id)).coverImage, shared);
});

test('a failed save or rejected publish deletes nothing', async (t) => {
  const { user, business } = await seedVendor();
  const oldCover = ownUrl(user, 'old');
  const product = await createProduct(user, business, { coverImage: oldCover });
  const deletes = recordS3Deletes(t);

  const save = t.mock.method(Product.prototype, 'save', async () => { throw new Error('synthetic save failure'); });
  const failed = await updateProduct(user, product._id, { coverImage: ownUrl(user, 'new') });
  save.mock.restore();
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(deletes, []);
  assert.equal((await Product.findById(product._id)).coverImage, oldCover);

  // Publish with a zero-price variant is rejected before any write.
  const [existing] = await ProductVariant.find({ productId: product._id });
  const rejected = await updateProduct(user, product._id, {
    coverImage: ownUrl(user, 'new'),
    isPublished: true,
    variants: [{ _id: String(existing._id), attributes: { Size: 'M' }, price: 0, stock: 2 }],
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.code, 'LISTING_PRICE_REQUIRED');
  assert.deepEqual(deletes, []);
  assert.equal((await Product.findById(product._id)).coverImage, oldCover);
});

test('a publish PUT without variants fails without deleting variants or price', async () => {
  const { user, business } = await seedVendor();
  // Zero-price draft variants: the publish must be rejected by the price rule.
  const product = await createProduct(user, business, {
    coverImage: ownUrl(user, 'cover'),
    variants: [variant('KEEP-1', 0, 'M'), variant('KEEP-2', 0, 'L')],
  });
  const before = await Product.findById(product._id).lean();

  const res = await updateProduct(user, product._id, { title: 'Renamed', isPublished: true });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'LISTING_PRICE_REQUIRED');
  assert.equal(await ProductVariant.countDocuments({ productId: product._id }), 2);
  const after = await Product.findById(product._id).lean();
  assert.equal(after.isPublished, false);
  assert.equal(String(after.price), String(before.price));
  assert.equal(after.title, before.title, 'rejected publish writes nothing');
});

test('a publish PUT that drops a variant and fails keeps every variant', async () => {
  const { user, business } = await seedVendor();
  const product = await createProduct(user, business, {
    coverImage: ownUrl(user, 'cover'),
    variants: [variant('DROP-1', 20, 'M'), variant('DROP-2', 30, 'L')],
  });
  const [first] = await ProductVariant.find({ productId: product._id, sku: /DROP-1$/ });

  const res = await updateProduct(user, product._id, {
    isPublished: true,
    variants: [{ _id: String(first._id), attributes: { Size: 'M' }, price: 0, stock: 2 }],
  });

  assert.equal(res.statusCode, 400);
  assert.equal(await ProductVariant.countDocuments({ productId: product._id }), 2);
});

test('draft PUT without variants keeps them; FE-shaped publish and empty array behave as before', async () => {
  const { user, business } = await seedVendor();
  const product = await createProduct(user, business, {
    coverImage: ownUrl(user, 'cover'),
    variants: [variant('FE-1', 20, 'M'), variant('FE-2', 30, 'L')],
  });

  const draft = await updateProduct(user, product._id, { title: 'Draft rename' });
  assert.equal(draft.statusCode, 200);
  assert.equal(await ProductVariant.countDocuments({ productId: product._id }), 2);
  assert.equal(String((await Product.findById(product._id)).price), '20');

  // Edit modal payload: every variant with its _id, publishing.
  const stored = await ProductVariant.find({ productId: product._id }).lean();
  const published = await updateProduct(user, product._id, {
    title: 'Published',
    isPublished: true,
    variants: stored.map((v) => ({
      _id: String(v._id),
      sku: v.sku,
      attributes: v.attributes,
      price: Number(v.price.toString()),
      stock: v.stock,
    })),
  });
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  assert.equal((await Product.findById(product._id)).isPublished, true);
  assert.equal(await ProductVariant.countDocuments({ productId: product._id, isPublished: true }), 2);

  // An explicit empty array on a draft save still removes all variants.
  const cleared = await updateProduct(user, product._id, { isPublished: false, variants: [] });
  assert.equal(cleared.statusCode, 200);
  assert.equal(await ProductVariant.countDocuments({ productId: product._id }), 0);
});

test('malformed variants payloads are rejected before any write', async (t) => {
  const { user, business } = await seedVendor();
  const product = await createProduct(user, business, {
    coverImage: ownUrl(user, 'cover'),
    variants: [variant('BAD-1', 20, 'M'), variant('BAD-2', 30, 'L')],
  });
  const [first] = await ProductVariant.find({ productId: product._id, sku: /BAD-1$/ });
  const productSave = t.mock.method(Product.prototype, 'save');
  const deleteMany = t.mock.method(ProductVariant, 'deleteMany');
  const line = (extra = {}) => ({ _id: String(first._id), attributes: { Size: 'M' }, price: 20, stock: 2, ...extra });

  for (const [variants, code] of [
    [[line(), line()], 'PRODUCT_VARIANT_INVALID'], // duplicate _id
    [[line({ _id: 'not-an-object-id' })], 'PRODUCT_VARIANT_INVALID'],
    [[null], 'PRODUCT_VALIDATION_FAILED'],
    [['variant'], 'PRODUCT_VALIDATION_FAILED'],
    [[[line()]], 'PRODUCT_VALIDATION_FAILED'],
  ]) {
    for (const isPublished of [false, true]) {
      const res = await updateProduct(user, product._id, { title: 'Changed', isPublished, variants });
      assert.equal(res.statusCode, 400, JSON.stringify(variants));
      assert.equal(res.body.code, code);
      assert.equal(typeof res.body.error, 'string');
    }
  }
  assert.equal(productSave.mock.callCount(), 0);
  assert.equal(deleteMany.mock.callCount(), 0);
  assert.equal(await ProductVariant.countDocuments({ productId: product._id }), 2);
  assert.equal((await Product.findById(product._id)).title, 'Synthetic Product');
});

test('a soft-deleted variant _id does not count as live for publishing', async () => {
  const { user, business } = await seedVendor();
  const product = await createProduct(user, business, {
    coverImage: ownUrl(user, 'cover'),
    variants: [variant('SOFT-1', 20, 'M'), variant('SOFT-2', 30, 'L')],
  });
  const [deleted] = await ProductVariant.find({ productId: product._id, sku: /SOFT-1$/ });
  await ProductVariant.updateOne({ _id: deleted._id }, { isDeleted: true });

  // Only the soft-deleted variant is sent, which would drop the live one.
  const res = await updateProduct(user, product._id, {
    isPublished: true,
    variants: [{ _id: String(deleted._id), attributes: { Size: 'M' }, price: 20, stock: 2 }],
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'LISTING_PRICE_REQUIRED');
  assert.equal(await ProductVariant.countDocuments({ productId: product._id, isDeleted: { $ne: true } }), 1);
  assert.equal((await Product.findById(product._id)).isPublished, false);
});

test('updateVariant deletes only the vendor own unreferenced replaced image, after the save', async (t) => {
  const { user: other } = await seedVendor();
  const { user, business } = await seedVendor();
  const product = await createProduct(user, business, { coverImage: ownUrl(user, 'cover') });
  const [stored] = await ProductVariant.find({ productId: product._id });
  const otherVendorImage = `${S3_BASE}products/${other._id}/${product._id}/variants/1/other.webp`;
  const onboardingImage = `${S3_BASE}vendor-onboarding/${user._id}/license.webp`;
  const ownImage = `${S3_BASE}products/${user._id}/${product._id}/variants/1/own.webp`;
  const newImage = `${S3_BASE}products/${user._id}/${product._id}/variants/1/new.webp`;
  await ProductVariant.updateOne({ _id: stored._id }, { images: [otherVendorImage, onboardingImage, ownImage] });
  const deletes = recordS3Deletes(t, null, stored._id);

  const res = await updateVariant(user, product._id, stored._id, { images: [newImage] });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(deletes, [{
    key: `products/${user._id}/${product._id}/variants/1/own.webp`,
    bucket: BUCKET,
    storedImages: [newImage], // the variant was already saved when the delete ran
  }]);
});

test('an updateVariant save failure deletes nothing', async (t) => {
  const { user, business } = await seedVendor();
  const product = await createProduct(user, business, { coverImage: ownUrl(user, 'cover') });
  const [stored] = await ProductVariant.find({ productId: product._id });
  const ownImage = `${S3_BASE}products/${user._id}/${product._id}/variants/1/own.webp`;
  await ProductVariant.updateOne({ _id: stored._id }, { images: [ownImage] });
  const deletes = recordS3Deletes(t);
  t.mock.method(ProductVariant.prototype, 'save', async () => { throw new Error('synthetic save failure'); });

  const res = await updateVariant(user, product._id, stored._id, {
    images: [`${S3_BASE}products/${user._id}/${product._id}/variants/1/new.webp`],
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(deletes, []);
  assert.deepEqual((await ProductVariant.findById(stored._id).lean()).images, [ownImage]);
});

// Combined #364 + #457 behavior on one product: the price summary uses the
// listing policy's effective price (sale if > 0, else base if > 0, skipping
// soft-deleted variants), so a $0 sale price never becomes the card price.
test('combined: edit-modal publish with salePrice 0 prices from base, cover delete after save, no-variants publish keeps both', async (t) => {
  const { user, business } = await seedVendor();
  const oldCover = ownUrl(user, 'combined-old');
  const newCover = ownUrl(user, 'combined-new');
  const product = await createProduct(user, business, {
    coverImage: oldCover,
    variants: [variant('COMBO-1', 20, 'M'), variant('COMBO-2', 30, 'L')],
  });
  const deletes = recordS3Deletes(t, product._id);

  // Edit modal payload: every variant with its _id and salePrice 0, publishing, new cover.
  const stored = await ProductVariant.find({ productId: product._id }).lean();
  const published = await updateProduct(user, product._id, {
    title: 'Combined',
    coverImage: newCover,
    isPublished: true,
    variants: stored.map((v) => ({
      _id: String(v._id),
      sku: v.sku,
      attributes: v.attributes,
      price: Number(v.price.toString()),
      salePrice: 0,
      stock: v.stock,
    })),
  });
  assert.equal(published.statusCode, 200, JSON.stringify(published.body));
  const afterPublish = await Product.findById(product._id).lean();
  assert.equal(afterPublish.isPublished, true);
  assert.equal(String(afterPublish.price), '20', 'salePrice 0 falls back to the $20 base price');
  assert.deepEqual(deletes, [{
    key: `products/${user._id}/covers/1700000000000-combined-old.webp`,
    bucket: BUCKET,
    storedCover: newCover, // deleted only after the new cover was saved
  }]);

  // Publish PUT without a variants array: variants and price are untouched.
  deletes.length = 0;
  const variantsBefore = await ProductVariant.find({ productId: product._id }).sort({ sku: 1 }).lean();
  const again = await updateProduct(user, product._id, { title: 'Combined again', isPublished: true });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  const variantsAfter = await ProductVariant.find({ productId: product._id }).sort({ sku: 1 }).lean();
  assert.deepEqual(
    variantsAfter.map((v) => [String(v._id), String(v.price), String(v.salePrice), v.isDeleted === true]),
    variantsBefore.map((v) => [String(v._id), String(v.price), String(v.salePrice), v.isDeleted === true]),
  );
  assert.equal(variantsAfter.length, 2);
  assert.equal(String((await Product.findById(product._id)).price), '20');
  assert.deepEqual(deletes, [], 'no cover change, no delete');
});

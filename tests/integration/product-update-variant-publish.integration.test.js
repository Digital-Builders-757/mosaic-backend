const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startHarness, resetDatabase, stopHarness, getApp } = require('./setup/harness');
const { createAgent } = require('./helpers/client');
const { registerAndVerify, login, seedApprovedBusiness } = require('./helpers/factories');
const User = require('../../models/User');
const Product = require('../../models/Product');
const ProductVariant = require('../../models/ProductVariant');
const { summarizeVariantPrices } = require('../../utils/productPriceSummary');

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

// Synthetic two-variant product, published through the product update
// endpoint so both variants start Published (the pre-existing behaviour).
async function createPublishedProduct(agent, business) {
  const created = await agent.post('/api/product').send({
    title: 'Synthetic Variant Publish Product',
    description: 'Synthetic product for per-variant Published/Draft regression',
    categoryId: new mongoose.Types.ObjectId().toString(),
    subcategoryId: new mongoose.Types.ObjectId().toString(),
    businessId: business._id.toString(),
    coverImage: 'https://example.test/variant-publish.webp',
    isPublished: false,
    variants: [
      { attributes: { Size: 'A' }, sku: 'SYN-VP-A', price: 20, stock: 2 },
      { attributes: { Size: 'B' }, sku: 'SYN-VP-B', price: 10, stock: 2 },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productId = created.body.product._id;
  const a = created.body.variants.find((v) => v.sku.endsWith('SYN-VP-A'));
  const b = created.body.variants.find((v) => v.sku.endsWith('SYN-VP-B'));

  const published = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);
  assert.equal((await Product.findById(productId)).isPublished, true);
  return { productId, a, b };
}

test('(a) per-variant Draft sent through PUT /api/product/:id is persisted', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  // Same shape as EditProductForm: product-level isPublished true plus a
  // per-variant Published/Draft choice.
  const res = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, price: 20, isPublished: true },
      { _id: b._id, attributes: { Size: 'B' }, price: 10, isPublished: false },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);
  const resB = res.body.variants.find((v) => String(v._id) === String(b._id));
  assert.equal(resB.isPublished, false);

  // Draft back to Published through the same endpoint.
  const republish = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: true },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: true },
    ],
  });
  assert.equal(republish.status, 200, JSON.stringify(republish.body));
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);
});

test('(b) variants without their own isPublished keep the product-level behaviour', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  // Draft B directly so "unchanged" is observable.
  await ProductVariant.updateOne({ _id: b._id }, { $set: { isPublished: false } });

  // No product-level flag and no per-variant flag: stored state is kept.
  const untouched = await agent.put(`/api/product/${productId}`).send({
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(untouched.status, 200, JSON.stringify(untouched.body));
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);

  // Product-level flag only: it still applies to every variant.
  const productLevel = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(productLevel.status, 200, JSON.stringify(productLevel.body));
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);

  // Product-level unpublish with no per-variant flags drafts every variant.
  const unpublish = await agent.put(`/api/product/${productId}`).send({
    isPublished: false,
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(unpublish.status, 200, JSON.stringify(unpublish.body));
  assert.equal((await Product.findById(productId)).isPublished, false);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);

  // A non-boolean per-variant value is ignored (falls back to product level).
  const nonBoolean = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: 'false' },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(nonBoolean.status, 200, JSON.stringify(nonBoolean.body));
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
});

test('(c) a new variant added on product update respects its own isPublished', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  const res = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: true },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: true },
      { attributes: { Size: 'C' }, sku: 'SYN-VP-C', price: 30, stock: 1, isPublished: false },
      { attributes: { Size: 'D' }, sku: 'SYN-VP-D', price: 40, stock: 1 },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const c = await ProductVariant.findOne({ productId, sku: /SYN-VP-C$/ });
  const d = await ProductVariant.findOne({ productId, sku: /SYN-VP-D$/ });
  assert.ok(c && d, 'new variants were created');
  assert.equal(c.isPublished, false, 'explicit Draft on a new variant is kept');
  assert.equal(d.isPublished, true, 'new variant without its own flag follows the product');

  // On an unpublished product a new variant may still be marked Published.
  await agent.put(`/api/product/${productId}`).send({ isPublished: false });
  const draftProduct = await agent.put(`/api/product/${productId}`).send({
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { attributes: { Size: 'E' }, sku: 'SYN-VP-E', price: 50, stock: 1, isPublished: true },
      { attributes: { Size: 'F' }, sku: 'SYN-VP-F', price: 60, stock: 1 },
    ],
  });
  assert.equal(draftProduct.status, 200, JSON.stringify(draftProduct.body));
  assert.equal((await ProductVariant.findOne({ productId, sku: /SYN-VP-E$/ })).isPublished, true);
  assert.equal((await ProductVariant.findOne({ productId, sku: /SYN-VP-F$/ })).isPublished, false);
});

test('(d) derived product price and publication stay consistent with per-variant Draft', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);
  assert.equal(priceOf(await Product.findById(productId)), 10);

  // Draft the cheaper variant B via product update.
  const res = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: true },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: false },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const stored = await Product.findById(productId);
  assert.equal(stored.isPublished, true, 'product stays published while a variant is published');
  // #365: product.price is summarised from non-deleted variants via the shared
  // helper; the stored value must match a fresh summary of what is persisted.
  const persisted = await ProductVariant.find({ productId, isDeleted: { $ne: true } });
  const expected = summarizeVariantPrices(persisted);
  assert.equal(stored.price.toString(), expected.price.toString());
  assert.equal(Number(res.body.product.price.$numberDecimal), priceOf(stored));

  // Parity: the update-variant endpoint produces the same variant state and
  // the same product price when making the same Draft choice.
  const viaVariantEndpoint = await agent
    .put(`/api/product/update-variant/${productId}/${b._id}`)
    .send({ isPublished: false });
  assert.equal(viaVariantEndpoint.status, 200, JSON.stringify(viaVariantEndpoint.body));
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);
  const afterVariantEndpoint = await Product.findById(productId);
  assert.equal(afterVariantEndpoint.isPublished, true);
  assert.equal(afterVariantEndpoint.price.toString(), stored.price.toString());

  // The publish price guard still runs on the variants the request leaves
  // published: a price change on the Draft variant does not block publishing.
  const priceChange = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, price: 22, isPublished: true },
      { _id: b._id, attributes: { Size: 'B' }, price: 8, isPublished: false },
    ],
  });
  assert.equal(priceChange.status, 200, JSON.stringify(priceChange.body));
  const afterPriceChange = await Product.findById(productId);
  const persistedAfter = await ProductVariant.find({ productId, isDeleted: { $ne: true } });
  assert.equal(
    afterPriceChange.price.toString(),
    summarizeVariantPrices(persistedAfter).price.toString()
  );
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);
});

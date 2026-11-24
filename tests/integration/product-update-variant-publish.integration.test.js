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

  // An unrecognised per-variant value is ignored (falls back to product level).
  // ('true'/'false' strings are honoured; see test (g).)
  const nonBoolean = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: 'no' },
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
  const unpublished = await agent.put(`/api/product/${productId}`).send({ isPublished: false });
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
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
  // #365: product.price is the lowest effective price among LIVE (published,
  // non-deleted) variants, via the shared helper; the stored value must match
  // a fresh summary of what is persisted. The drafted $10 variant B no longer
  // sets the price, so the card shows A's $20.
  const persisted = await ProductVariant.find({ productId, isDeleted: { $ne: true } });
  const expected = summarizeVariantPrices(persisted);
  assert.equal(stored.price.toString(), expected.price.toString());
  assert.equal(priceOf(stored), 20);
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
  // Draft B ($8) is not live, so the live A ($22) sets product.price.
  assert.equal(priceOf(afterPriceChange), 22);

  // Republishing B makes its $8 the live minimum again.
  const republishB = await agent
    .put(`/api/product/update-variant/${productId}/${b._id}`)
    .send({ isPublished: true });
  assert.equal(republishB.status, 200, JSON.stringify(republishB.body));
  assert.equal(priceOf(await Product.findById(productId)), 8);

  // Soft-deleting the live A leaves only B (published) to price the product.
  const deletedA = await agent.delete(`/api/product/delete-variant/${productId}/${a._id}`);
  assert.equal(deletedA.status, 200, JSON.stringify(deletedA.body));
  assert.equal(priceOf(await Product.findById(productId)), 8);
});

test('(d2) a fully Draft product keeps a fallback price from all non-deleted variants', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  // All variants Draft through product update: the product is unpublished and
  // product.price falls back to the non-deleted variants (lowest $10).
  const res = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: false },
      { _id: b._id, attributes: { Size: 'B' }, price: 12, isPublished: false },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await Product.findById(productId);
  assert.equal(stored.isPublished, false);
  assert.equal(priceOf(stored), 12);

  // Publishing only A through update-variant makes A's $20 the live price.
  const publishA = await agent
    .put(`/api/product/update-variant/${productId}/${a._id}`)
    .send({ isPublished: true });
  assert.equal(publishA.status, 200, JSON.stringify(publishA.body));
  const afterPublish = await Product.findById(productId);
  assert.equal(afterPublish.isPublished, true);
  assert.equal(priceOf(afterPublish), 20);
});

// Published product: live A $10 + live B $0.
async function createPricedAndUnpricedProduct(agent, business, suffix) {
  const created = await agent.post('/api/product').send({
    title: 'Synthetic Price On Request Product',
    description: 'Synthetic product: live $10 variant plus live $0 variant',
    categoryId: new mongoose.Types.ObjectId().toString(),
    subcategoryId: new mongoose.Types.ObjectId().toString(),
    businessId: business._id.toString(),
    coverImage: 'https://example.test/price-on-request.webp',
    isPublished: true,
    variants: [
      { attributes: { Size: 'A' }, sku: `SYN-POR-${suffix}-A`, price: 10, stock: 2 },
      { attributes: { Size: 'B' }, sku: `SYN-POR-${suffix}-B`, price: 0, stock: 2 },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productId = created.body.product._id;
  const a = created.body.variants.find((v) => v.sku.endsWith(`SYN-POR-${suffix}-A`));
  const b = created.body.variants.find((v) => v.sku.endsWith(`SYN-POR-${suffix}-B`));
  const before = await Product.findById(productId);
  assert.equal(before.isPublished, true);
  assert.equal(priceOf(before), 10);
  return { productId, a, b };
}

test('(d3) drafting the only priced variant (update-variant) auto-unpublishes; price null', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPricedAndUnpricedProduct(agent, business, 'UV');

  const res = await agent
    .put(`/api/product/update-variant/${productId}/${a._id}`)
    .send({ isPublished: false });
  // The vendor's Draft is accepted, not rejected.
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.autoUnpublished, true);

  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);
  const after = await Product.findById(productId);
  // Only the $0 B is live: no priced live variant, so the product is
  // unpublished (same rule as the publish check) and the price is null.
  assert.equal(after.isPublished, false);
  assert.equal(after.price, null);
});

test('(d4) deleting the only priced variant (delete-variant) auto-unpublishes; price null', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPricedAndUnpricedProduct(agent, business, 'DV');

  const res = await agent.delete(`/api/product/delete-variant/${productId}/${a._id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.autoUnpublished, true);

  assert.equal((await ProductVariant.findById(a._id)).isDeleted, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);
  const after = await Product.findById(productId);
  assert.equal(after.isPublished, false);
  assert.equal(after.price, null);
});

test('(d5) deleting / drafting a variant while a priced live variant remains keeps the product published', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  const drafted = await agent
    .put(`/api/product/update-variant/${productId}/${b._id}`)
    .send({ isPublished: false });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  assert.equal(drafted.body.autoUnpublished, undefined);
  assert.equal((await Product.findById(productId)).isPublished, true);

  const deleted = await agent.delete(`/api/product/delete-variant/${productId}/${b._id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.autoUnpublished, undefined);
  const after = await Product.findById(productId);
  assert.equal(after.isPublished, true);
  assert.equal(priceOf(after), 20);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
});

test('(d6) product update without a publish flag that leaves no priced live variant auto-unpublishes', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPricedAndUnpricedProduct(agent, business, 'UP');

  // No product-level isPublished: an edit, not a publish request.
  const res = await agent.put(`/api/product/${productId}`).send({
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: false },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.autoUnpublished, true);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);
  const after = await Product.findById(productId);
  assert.equal(after.isPublished, false);
  assert.equal(after.price, null);

  // The same state sent as an explicit publish request is still rejected.
  const publish = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: false },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: true },
    ],
  });
  assert.equal(publish.status, 400, JSON.stringify(publish.body));
  assert.equal(publish.body.code, 'LISTING_PRICE_REQUIRED');
  assert.equal((await Product.findById(productId)).isPublished, false);
});

test('(g) string publish flags behave like booleans on product update; garbage falls back', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  // Per-variant 'false' string drafts B; product-level 'true' keeps it published.
  const drafted = await agent.put(`/api/product/${productId}`).send({
    isPublished: 'true',
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: 'true' },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: 'false' },
    ],
  });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  assert.equal((await Product.findById(productId)).isPublished, true);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);

  // Product-level 'false' string unpublishes and drafts flagless variants.
  const unpublished = await agent.put(`/api/product/${productId}`).send({
    isPublished: 'false',
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
  assert.equal(unpublished.body.autoUnpublished, undefined, 'explicit unpublish is not "auto"');
  assert.equal((await Product.findById(productId)).isPublished, false);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);

  // Garbage product-level and per-variant values are ignored: stored state kept.
  const garbage = await agent.put(`/api/product/${productId}`).send({
    isPublished: 'yes',
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: 'maybe' },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: 'nope' },
    ],
  });
  assert.equal(garbage.status, 200, JSON.stringify(garbage.body));
  assert.equal((await Product.findById(productId)).isPublished, false);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);
});

test('(h) numeric 1/0 and "1"/"0" publish flags keep their boolean meaning on product update', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  // Product-level 1, per-variant '1' / 0: B drafted, product stays published.
  const mixed = await agent.put(`/api/product/${productId}`).send({
    isPublished: 1,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: '1' },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: 0 },
    ],
  });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal((await Product.findById(productId)).isPublished, true);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);

  // Product-level '0' unpublishes and drafts flagless variants (explicit, not auto).
  const zero = await agent.put(`/api/product/${productId}`).send({
    isPublished: '0',
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(zero.status, 200, JSON.stringify(zero.body));
  assert.equal(zero.body.autoUnpublished, undefined);
  assert.equal((await Product.findById(productId)).isPublished, false);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);

  // Product-level 0 then '1' with no per-variant flags republishes everything.
  const one = await agent.put(`/api/product/${productId}`).send({
    isPublished: '1',
    variants: [
      { _id: a._id, attributes: { Size: 'A' } },
      { _id: b._id, attributes: { Size: 'B' } },
    ],
  });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal((await Product.findById(productId)).isPublished, true);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, true);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, true);
});

test('(e) every variant Draft with product isPublished:true unpublishes the product', async () => {
  const { agent, business } = await setupVendor();
  const { productId, a, b } = await createPublishedProduct(agent, business);

  // Same rule as update-variant/delete-variant: no published variant left
  // means the product is unpublished, not rejected and not left published.
  const res = await agent.put(`/api/product/${productId}`).send({
    isPublished: true,
    variants: [
      { _id: a._id, attributes: { Size: 'A' }, isPublished: false },
      { _id: b._id, attributes: { Size: 'B' }, isPublished: false },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.product.isPublished, false);
  assert.equal(res.body.autoUnpublished, true);
  assert.equal((await Product.findById(productId)).isPublished, false);
  assert.equal((await ProductVariant.findById(a._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(b._id)).isPublished, false);
  assert.equal(await ProductVariant.countDocuments({ productId }), 2);
});

test('(f) publishing with only an unpriced variant published (priced one Draft) is rejected before any write', async () => {
  const { agent, business } = await setupVendor();
  const created = await agent.post('/api/product').send({
    title: 'Synthetic Unpriced Publish Product',
    description: 'Synthetic product: only the priced variant is Draft',
    categoryId: new mongoose.Types.ObjectId().toString(),
    subcategoryId: new mongoose.Types.ObjectId().toString(),
    businessId: business._id.toString(),
    coverImage: 'https://example.test/variant-publish-unpriced.webp',
    isPublished: false,
    variants: [
      { attributes: { Size: 'Z' }, sku: 'SYN-VP-ZERO', price: 0, stock: 1 },
      { attributes: { Size: 'P' }, sku: 'SYN-VP-PRICED', price: 15, stock: 1 },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productId = created.body.product._id;
  const zero = created.body.variants.find((v) => v.sku.endsWith('SYN-VP-ZERO'));
  const priced = created.body.variants.find((v) => v.sku.endsWith('SYN-VP-PRICED'));
  const before = await Product.findById(productId);

  const res = await agent.put(`/api/product/${productId}`).send({
    title: 'Renamed before rejection',
    isPublished: true,
    variants: [
      { _id: zero._id, attributes: { Size: 'Z' }, isPublished: true },
      { _id: priced._id, attributes: { Size: 'P' }, isPublished: false },
    ],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'LISTING_PRICE_REQUIRED');

  const after = await Product.findById(productId);
  assert.equal(after.title, before.title);
  assert.equal(after.isPublished, false);
  assert.equal(String(after.price), String(before.price));
  assert.equal(await ProductVariant.countDocuments({ productId }), 2);
  assert.equal((await ProductVariant.findById(zero._id)).isPublished, false);
  assert.equal((await ProductVariant.findById(priced._id)).isPublished, false);
});

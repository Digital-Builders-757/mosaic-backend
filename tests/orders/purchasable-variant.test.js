const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { isPurchasableVariant } = require('../../utils/checkoutGuards');
const Product = require('../../models/Product');

const productId = new mongoose.Types.ObjectId();
const eligible = () => ({
  isPublished: true, isDeleted: false,
  productId: { _id: productId, isPublished: true, isActive: true, isDeleted: false },
});

test('eligible published, active, undeleted product and variant is purchasable', () => {
  assert.equal(isPurchasableVariant(eligible(), String(productId)), true);
});

test('hidden product or variant flags are not purchasable', () => {
  for (const [target, field, value] of [
    ['product', 'isPublished', false], ['product', 'isActive', false],
    ['product', 'isActive', null], ['product', 'isDeleted', true],
    ['variant', 'isPublished', false], ['variant', 'isDeleted', true],
  ]) {
    const variant = eligible();
    (target === 'product' ? variant.productId : variant)[field] = value;
    assert.equal(isPurchasableVariant(variant, String(productId)), false, `${target}.${field}=${value}`);
  }
});

test('missing variant, unpopulated product, or product id mismatch is not purchasable', () => {
  assert.equal(isPurchasableVariant(null, String(productId)), false);
  assert.equal(isPurchasableVariant(undefined, String(productId)), false);
  assert.equal(isPurchasableVariant({ ...eligible(), productId: null }, String(productId)), false);
  assert.equal(isPurchasableVariant(eligible(), String(new mongoose.Types.ObjectId())), false);
  assert.equal(isPurchasableVariant(eligible(), [String(productId)]), false, 'non-string id must not coerce');
});

test('legacy product documents without isActive hydrate to active (schema default)', () => {
  const legacy = Product.hydrate({ _id: productId, isPublished: true, isDeleted: false });
  assert.equal(legacy.isActive, true);
  assert.equal(isPurchasableVariant({ isPublished: true, isDeleted: false, productId: legacy }, String(productId)), true);
});

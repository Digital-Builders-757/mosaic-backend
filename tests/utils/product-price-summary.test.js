const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { summarizeVariantPrices } = require('../../utils/productPriceSummary');

const { Decimal128 } = mongoose.Types;
const dec = (value) => Decimal128.fromString(String(value));
const num = (value) => (value === null ? null : Number(value.toString()));
const summaryOf = (variants) => {
  const summary = summarizeVariantPrices(variants);
  return { price: num(summary.price), maxPrice: num(summary.maxPrice) };
};

test('Decimal128("0") sale price is ignored and falls back to base price', () => {
  assert.deepEqual(
    summaryOf([{ price: dec('46.64'), salePrice: dec('0') }]),
    { price: 46.64, maxPrice: 46.64 }
  );
});

test('numeric 0, null, undefined and empty-string sale prices are ignored', () => {
  for (const salePrice of [0, null, undefined, '', '0']) {
    assert.deepEqual(
      summaryOf([{ price: dec('20'), salePrice }]),
      { price: 20, maxPrice: 20 },
      `salePrice=${JSON.stringify(salePrice)}`
    );
  }
});

test('negative and non-numeric sale prices are ignored', () => {
  assert.equal(summaryOf([{ price: dec('20'), salePrice: dec('-5') }]).price, 20);
  assert.equal(summaryOf([{ price: 20, salePrice: 'abc' }]).price, 20);
});

test('a positive sale price wins over base price (Decimal128 or string)', () => {
  assert.equal(summaryOf([{ price: dec('20'), salePrice: dec('15.5') }]).price, 15.5);
  assert.equal(summaryOf([{ price: '20', salePrice: '12' }]).price, 12);
});

test('summary uses min/max effective price across variants', () => {
  const summary = summarizeVariantPrices([
    { price: dec('30'), salePrice: dec('25') },
    { price: dec('10'), salePrice: dec('0') },
    { price: dec('50'), salePrice: null },
  ]);
  assert.equal(num(summary.price), 10);
  assert.equal(num(summary.maxPrice), 50);
  assert.ok(summary.price instanceof Decimal128);
});

test('a $0 base-price variant is skipped, matching the listing price policy', () => {
  assert.deepEqual(
    summaryOf([{ price: dec('0') }, { price: dec('20') }]),
    { price: 20, maxPrice: 20 }
  );
  assert.deepEqual(summaryOf([{ price: 0 }, { price: 20 }]), { price: 20, maxPrice: 20 });
});

test('all-$0 variants yield null price fields', () => {
  assert.deepEqual(
    summarizeVariantPrices([{ price: dec('0'), salePrice: dec('0') }, { price: 0 }]),
    { price: null, maxPrice: null }
  );
});

test('soft-deleted variants are excluded', () => {
  assert.deepEqual(
    summaryOf([
      { price: dec('5'), isDeleted: true },
      { price: dec('40'), salePrice: dec('0'), isDeleted: false },
    ]),
    { price: 40, maxPrice: 40 }
  );
});

test('Draft (isPublished:false) variants do not set the price when a live variant is priced', () => {
  assert.deepEqual(
    summaryOf([
      { price: dec('8'), isPublished: false },
      { price: dec('20'), isPublished: true },
      { price: dec('30'), salePrice: dec('25'), isPublished: true },
      { price: dec('99'), isPublished: false },
    ]),
    { price: 20, maxPrice: 25 }
  );
});

test('variants without an isPublished field count as live (same test as the publish check)', () => {
  assert.deepEqual(
    summaryOf([{ price: dec('15') }, { price: dec('5'), isPublished: false }]),
    { price: 15, maxPrice: 15 }
  );
});

test('all variants Draft falls back to all non-deleted variants', () => {
  assert.deepEqual(
    summaryOf([
      { price: dec('12'), isPublished: false },
      { price: dec('30'), salePrice: dec('18'), isPublished: false },
      { price: dec('4'), isPublished: false, isDeleted: true },
    ]),
    { price: 12, maxPrice: 18 }
  );
});

test('live variants with no usable price fall back to all non-deleted variants', () => {
  assert.deepEqual(
    summaryOf([
      { price: dec('0'), salePrice: dec('0'), isPublished: true },
      { price: dec('14'), isPublished: false },
    ]),
    { price: 14, maxPrice: 14 }
  );
});

test('a deleted live variant does not set the price', () => {
  assert.deepEqual(
    summaryOf([
      { price: dec('3'), isPublished: true, isDeleted: true },
      { price: dec('9'), isPublished: false },
      { price: dec('11'), isPublished: true },
    ]),
    { price: 11, maxPrice: 11 }
  );
});

test('no variants (or only deleted / unusable ones) yields null price fields', () => {
  assert.deepEqual(summarizeVariantPrices([]), { price: null, maxPrice: null });
  assert.deepEqual(summarizeVariantPrices(undefined), { price: null, maxPrice: null });
  assert.deepEqual(
    summarizeVariantPrices([{ price: dec('9'), isDeleted: true }, { price: null }]),
    { price: null, maxPrice: null }
  );
});

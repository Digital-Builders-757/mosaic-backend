const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeOptionalDraftFields,
} = require('../../utils/vendorOnboardingProfileFields');

test('blank optional enum and number fields are removed and reported as cleared', () => {
  const { payload, clearedFields } = normalizeOptionalDraftFields({
    employeesCount: '',
    ownershipType: '   ',
    yearsInBusiness: null,
    businessType: '\t',
    characterLimit: '',
    businessName: 'Keep Me',
  });

  assert.deepEqual(payload, { businessName: 'Keep Me' });
  assert.deepEqual(clearedFields.sort(), [
    'businessType',
    'characterLimit',
    'employeesCount',
    'ownershipType',
    'yearsInBusiness',
  ]);
});

test('non-blank enum values are trimmed and passed through (even if invalid)', () => {
  const { payload, clearedFields } = normalizeOptionalDraftFields({
    employeesCount: ' 2-5 ',
    ownershipType: 'Partnership',
    characterLimit: 250,
  });

  assert.deepEqual(payload, {
    employeesCount: '2-5',
    ownershipType: 'Partnership',
    characterLimit: 250,
  });
  assert.deepEqual(clearedFields, []);
});

test('absent fields are left alone', () => {
  const { payload, clearedFields } = normalizeOptionalDraftFields({ businessName: 'X' });
  assert.deepEqual(payload, { businessName: 'X' });
  assert.deepEqual(clearedFields, []);
});

test('blank entries are dropped from minorityCategories', () => {
  assert.deepEqual(
    normalizeOptionalDraftFields({ minorityCategories: ['', ' Woman ', '  ', 'Asian'] }).payload,
    { minorityCategories: ['Woman', 'Asian'] }
  );
  assert.deepEqual(
    normalizeOptionalDraftFields({ minorityCategories: '' }).payload,
    { minorityCategories: [] }
  );
});

test('non-numeric characterLimit is reported invalid; numeric strings are accepted', () => {
  assert.deepEqual(
    normalizeOptionalDraftFields({ characterLimit: 'lots' }).invalidFields,
    ['characterLimit']
  );
  assert.deepEqual(
    normalizeOptionalDraftFields({ characterLimit: { $gt: 1 } }).invalidFields,
    ['characterLimit']
  );
  const ok = normalizeOptionalDraftFields({ characterLimit: ' 300 ' });
  assert.deepEqual(ok.invalidFields, []);
  assert.deepEqual(ok.payload, { characterLimit: '300' });
});

test('input payload is not mutated', () => {
  const input = { employeesCount: '' };
  normalizeOptionalDraftFields(input);
  assert.deepEqual(input, { employeesCount: '' });
});

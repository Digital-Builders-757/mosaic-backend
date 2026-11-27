// Stage-1 draft save with optional selects left at "Select" (FE sends "").
// Regression: "" reached the employeesCount enum and the save returned 500
// with the raw Mongoose validation message. In-memory Mongo via the harness.
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
  registerAndVerify,
  login,
  validStage1Draft,
} = require('./helpers/factories');
const User = require('../../models/User');
const VendorOnboarding = require('../../models/VendorOnboardingStage1');

test.before(() => startHarness());
test.afterEach(() => resetDatabase());
test.after(() => stopHarness());

async function vendorAgent() {
  const agent = createAgent(getApp());
  const vendor = await registerAndVerify(agent, { role: 'business_owner' });
  await login(agent, vendor.email, vendor.password);
  const user = await User.findOne({ email: vendor.email });
  return { agent, user };
}

function storedFor(user) {
  return VendorOnboarding.findOne({ userId: user._id }).lean();
}

function assertNoRawValidationText(body) {
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /not a valid enum value/i);
  assert.doesNotMatch(text, /validation failed:/i);
  assert.doesNotMatch(text, /Cast to/i);
  assert.doesNotMatch(text, /VendorOnboardingStage1/);
}

test('draft save with numberOfEmployees "" succeeds and leaves employeesCount unset', async () => {
  const { agent, user } = await vendorAgent();

  const res = await agent
    .post('/api/vendor-onboarding/draft')
    .send({ ...validStage1Draft, numberOfEmployees: '' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  const stored = await storedFor(user);
  assert.ok(stored, 'a record is created');
  assert.equal(stored.businessName, validStage1Draft.businessName);
  assert.equal(stored.employeesCount ?? null, null);
});

test('draft save with whitespace-only optional selects succeeds and leaves them unset', async () => {
  const { agent, user } = await vendorAgent();

  const res = await agent.post('/api/vendor-onboarding/draft').send({
    ...validStage1Draft,
    businessType: '   ',
    numberOfEmployees: '  ',
    businessOwnershipType: '',
    yearsInBusiness: ' ',
    characterLimit: '',
    minorityCategories: ['', '  '],
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await storedFor(user);
  assert.equal(stored.employeesCount ?? null, null);
  assert.equal(stored.ownershipType ?? null, null);
  assert.equal(stored.yearsInBusiness ?? null, null);
  assert.equal(stored.businessType ?? null, null);
  assert.equal(stored.characterLimit, 0, 'existing draft default for characterLimit');
  assert.deepEqual(stored.minorityCategories, []);
});

test('draft save with a valid numberOfEmployees stores it', async () => {
  const { agent, user } = await vendorAgent();

  const res = await agent
    .post('/api/vendor-onboarding/draft')
    .send({ ...validStage1Draft, numberOfEmployees: '2-5', businessOwnershipType: 'Sole Proprietor' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await storedFor(user);
  assert.equal(stored.employeesCount, '2-5');
  assert.equal(stored.ownershipType, 'Sole Proprietor');
});

test('choosing "Select" again clears a previously stored optional value', async () => {
  const { agent, user } = await vendorAgent();

  await agent
    .post('/api/vendor-onboarding/draft')
    .send({ ...validStage1Draft, numberOfEmployees: '6-10', yearsInBusiness: '2yr+' });
  assert.equal((await storedFor(user)).employeesCount, '6-10');

  const res = await agent
    .post('/api/vendor-onboarding/draft')
    .send({ numberOfEmployees: '', yearsInBusiness: '' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await storedFor(user);
  assert.equal(stored.employeesCount ?? null, null);
  assert.equal(stored.yearsInBusiness ?? null, null);
  assert.equal(stored.businessName, validStage1Draft.businessName, 'other fields preserved');
});

test('draft save with an invalid numberOfEmployees returns 400 without raw validation text', async () => {
  const { agent, user } = await vendorAgent();

  const res = await agent
    .post('/api/vendor-onboarding/draft')
    .send({ ...validStage1Draft, numberOfEmployees: 'about a hundred' });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'VALIDATION_FAILED');
  assert.deepEqual(Object.keys(res.body.fieldErrors), ['employeesCount']);
  assertNoRawValidationText(res.body);
  assert.doesNotMatch(JSON.stringify(res.body), /about a hundred/);
  assert.equal(await storedFor(user), null, 'nothing is persisted');
});

test('draft save with other invalid optional values returns 400 naming only the fields', async () => {
  const { agent } = await vendorAgent();

  const res = await agent.post('/api/vendor-onboarding/draft').send({
    ...validStage1Draft,
    businessOwnershipType: 'Partnership',
    minorityCategories: ['Martian'],
  });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'VALIDATION_FAILED');
  const fields = Object.keys(res.body.fieldErrors).sort();
  assert.ok(fields.includes('ownershipType'), fields.join(','));
  assert.ok(fields.some((field) => field.startsWith('minorityCategories')), fields.join(','));
  assertNoRawValidationText(res.body);
  assert.doesNotMatch(JSON.stringify(res.body), /Partnership|Martian/);
});

test('draft save with a non-numeric characterLimit returns 400 instead of silently storing 0', async () => {
  const { agent, user } = await vendorAgent();

  const res = await agent
    .post('/api/vendor-onboarding/draft')
    .send({ ...validStage1Draft, characterLimit: 'lots' });

  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'VALIDATION_FAILED');
  assert.deepEqual(Object.keys(res.body.fieldErrors), ['characterLimit']);
  assertNoRawValidationText(res.body);
  assert.equal(await storedFor(user), null, 'nothing is persisted');
});

test('submit still requires businessType after a draft left it blank', async () => {
  const { agent, user } = await vendorAgent();

  const draftRes = await agent
    .post('/api/vendor-onboarding/draft')
    .send({ ...validStage1Draft, businessType: '', numberOfEmployees: '' });
  assert.equal(draftRes.status, 200, JSON.stringify(draftRes.body));

  await VendorOnboarding.updateOne(
    { userId: user._id },
    { verificationPayment: { status: 'paid', paymentIntentId: 'pi_integration_test' } }
  );

  const submitRes = await agent.post('/api/vendor-onboarding/submit');
  assert.equal(submitRes.status, 400, JSON.stringify(submitRes.body));
  assert.ok(submitRes.body.errors.includes('Business type is required'));
  assert.equal((await storedFor(user)).status, 'draft');
});

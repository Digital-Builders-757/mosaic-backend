// #516 "never revert": a verification payment can only be created for a payable
// application, and a stale draft save can never undo a concurrent submit.
// In-memory Mongo; Stripe is a stub that fails the test if it is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { startHarness, resetDatabase, stopHarness } = require('./setup/harness');
const { seedVendorOnboarding } = require('./helpers/factories');
const User = require('../../models/User');
const VendorOnboarding = require('../../models/VendorOnboardingStage1');

test.before(() => startHarness());
test.afterEach(() => resetDatabase());
test.after(() => stopHarness());

const controllerPath = require.resolve('../../controllers/vendorOnboarding.controller');

function loadController() {
  const calls = { stripe: 0 };
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'stripe') {
      return () => ({
        paymentIntents: {
          retrieve: async () => { calls.stripe++; throw new Error('stripe must not be called'); },
          create: async () => { calls.stripe++; throw new Error('stripe must not be called'); },
          cancel: async () => { calls.stripe++; },
        },
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[controllerPath];
  try {
    return { controller: require(controllerPath), calls };
  } finally {
    Module._load = originalLoad;
  }
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

let seq = 0;
async function vendor() {
  seq += 1;
  return User.create({
    name: `No Revert Vendor ${seq}`,
    mobile: `+1404555${String(1000 + seq).slice(-4)}`,
    email: `no-revert-${seq}@example.com`,
    password: 'TestPassword123!',
    role: 'business_owner',
  });
}

for (const status of ['submitted', 'verified']) {
  test(`create-payment refuses a ${status} application with an unpaid record and changes nothing`, async () => {
    const user = await vendor();
    const submittedAt = new Date('2026-01-02T03:04:05Z');
    const seeded = await seedVendorOnboarding(user, {
      status,
      submittedAt,
      verificationPayment: { status: 'pending', paymentIntentId: 'pi_legacy_unpaid' },
    });
    const { controller, calls } = loadController();
    const out = res();
    await controller.createVerificationPayment({ user: { _id: user._id } }, out);

    assert.equal(out.statusCode, 409);
    assert.equal(out.body.code, 'APPLICATION_NOT_PAYABLE');
    assert.equal(calls.stripe, 0, 'no Stripe call for a non-payable application');
    const after = await VendorOnboarding.findById(seeded._id).lean();
    assert.equal(after.status, status);
    assert.equal(after.submittedAt.toISOString(), submittedAt.toISOString());
    assert.equal(after.verificationPayment.paymentIntentId, 'pi_legacy_unpaid');
  });
}

test('a stale draft save cannot revert a submit that landed after its read', async () => {
  const user = await vendor();
  const seeded = await seedVendorOnboarding(user, {
    status: 'rejected',
    verificationPayment: { status: 'paid' },
  });
  const { controller } = loadController();

  // Let saveDraft read the rejected record, then land a concurrent submit.
  const originalFindOne = VendorOnboarding.findOne;
  VendorOnboarding.findOne = function patchedFindOne(...args) {
    const query = originalFindOne.apply(this, args);
    const originalExec = query.exec.bind(query);
    query.exec = async (...execArgs) => {
      const doc = await originalExec(...execArgs);
      await VendorOnboarding.collection.updateOne(
        { _id: seeded._id },
        { $set: { status: 'submitted', submittedAt: new Date() } }
      );
      return doc;
    };
    return query;
  };
  const out = res();
  try {
    await controller.saveDraft({ user: { _id: user._id }, body: { businessName: 'Stale Draft Name' } }, out);
  } finally {
    VendorOnboarding.findOne = originalFindOne;
  }

  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, 'APPLICATION_STATE_CHANGED');
  const after = await VendorOnboarding.findById(seeded._id).lean();
  assert.equal(after.status, 'submitted', 'the concurrent submit wins');
  assert.notEqual(after.businessName, 'Stale Draft Name');
});

test('control: an uncontested draft save still moves rejected to draft', async () => {
  const user = await vendor();
  const seeded = await seedVendorOnboarding(user, {
    status: 'rejected',
    verificationPayment: { status: 'paid' },
  });
  const { controller } = loadController();
  const out = res();
  await controller.saveDraft({ user: { _id: user._id }, body: { businessName: 'Corrected Name LLC' } }, out);

  assert.equal(out.statusCode, 200);
  const after = await VendorOnboarding.findById(seeded._id).lean();
  assert.equal(after.status, 'draft');
  assert.equal(after.businessName, 'Corrected Name LLC');
});

test('control: create-payment still reports already paid before the status guard', async () => {
  const user = await vendor();
  await seedVendorOnboarding(user, { status: 'verified', verificationPayment: { status: 'paid' } });
  const { controller, calls } = loadController();
  const out = res();
  await controller.createVerificationPayment({ user: { _id: user._id } }, out);
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.code, 'ALREADY_PAID');
  assert.equal(calls.stripe, 0);
});

for (const status of ['draft', 'payment_pending', 'rejected']) {
  test(`control: a ${status} application still gets a verification payment`, async () => {
    const user = await vendor();
    const seeded = await seedVendorOnboarding(user, { status, verificationPayment: { status: 'not_started' } });
    const created = [];
    const originalLoad = Module._load;
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'stripe') return () => ({ paymentIntents: {
        retrieve: async () => { throw new Error('unexpected retrieve'); },
        create: async (args) => { created.push(args); return { id: `pi_ok_${status}`, client_secret: 'cs_test_synthetic', status: 'requires_payment_method' }; },
        cancel: async () => {},
      } });
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[controllerPath];
    let controller;
    try { controller = require(controllerPath); } finally { Module._load = originalLoad; }
    const out = res();
    await controller.createVerificationPayment({ user: { _id: user._id } }, out);
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(created.length, 1);
    assert.equal(created[0].amount, 2499);
    const after = await VendorOnboarding.findById(seeded._id).lean();
    assert.equal(after.status, 'payment_pending');
    assert.equal(after.verificationPayment.paymentIntentId, `pi_ok_${status}`);
  });
}

test('legacy record with no stored status can still save a draft', async () => {
  const user = await vendor();
  const seeded = await seedVendorOnboarding(user, { status: 'draft' });
  await VendorOnboarding.collection.updateOne({ _id: seeded._id }, { $unset: { status: 1 } });
  const { controller } = loadController();
  const out = res();
  await controller.saveDraft({ user: { _id: user._id }, body: { businessName: 'Legacy Fix LLC' } }, out);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  const after = await VendorOnboarding.findById(seeded._id).lean();
  assert.equal(after.businessName, 'Legacy Fix LLC');
});

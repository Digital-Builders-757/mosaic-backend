/**
 * Regression: GET /api/vendor-onboarding/status/:applicationId picked the
 * user's NEWEST subscription. A newer pending attempt (retried or abandoned
 * checkout) therefore pushed a paid vendor back to "Stage 2 - Payment Pending",
 * and an expired attempt could never be cleared.
 *
 * Rule: an active subscription wins; otherwise the newest attempt that is not
 * expired/cancelled; otherwise none ("Select Subscription Plan").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const controllerPath = path.resolve(__dirname, '../../controllers/vendorOnboarding.controller.js');

const userId = '507f1f77bcf86cd799439011';
const applicationId = 'APP-TEST-SUBSEL';

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function matches(record, query) {
  return Object.entries(query).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && Array.isArray(cond.$nin)) {
      return !cond.$nin.includes(record[key]);
    }
    return String(record[key]) === String(cond);
  });
}

function subscriptionModel(records) {
  return {
    findOne: (query) => ({
      sort: () => ({
        populate: async () => {
          const hits = records
            .filter((r) => matches(r, query))
            .sort((a, b) => b.createdAt - a.createdAt);
          return hits[0] || null;
        },
      }),
    }),
  };
}

function loadController(records) {
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
  const onboarding = {
    applicationId,
    userId,
    status: 'verified',
    // No logo/bio: an active plan stops at Stage 3 without Business lookups.
    businessProfileImage: { url: '' },
    businessBio: '',
    save: async () => {},
  };
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'stripe') return () => ({ paymentIntents: {} });
    if (request === '../models/VendorOnboardingStage1') return { findOne: async () => onboarding };
    if (request === '../models/Subscription') return subscriptionModel(records);
    if (request === '../models/Business') {
      return { findOne: () => ({ select: () => ({ lean: async () => null }) }) };
    }
    if (request === '../utils/WellcomeMailer') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[controllerPath];
  let loaded;
  try {
    loaded = require(controllerPath);
  } finally {
    Module._load = originalLoad;
  }
  // The controller also resolves models lazily; pin those to the mocks too.
  const pin = (rel, exports) => {
    const file = path.resolve(__dirname, rel);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  pin('../../models/VendorOnboardingStage1.js', { findOne: async () => onboarding });
  pin('../../models/Subscription.js', subscriptionModel(records));
  pin('../../models/Business.js', { findOne: () => ({ select: () => ({ lean: async () => null }) }) });
  return loaded;
}

async function statusFor(records) {
  const controller = loadController(records);
  const res = mockResponse();
  await controller.getStatusByApplicationId(
    { params: { applicationId }, user: { _id: userId, role: 'business_owner' } },
    res
  );
  assert.equal(res.body?.success, true, JSON.stringify(res.body));
  return res.body.data;
}

const sub = (id, status, day) => ({
  _id: id,
  userId,
  status,
  subscriptionPlanId: { name: 'Launch Plan', price: 99 },
  createdAt: new Date(`2026-11-${String(day).padStart(2, '0')}T00:00:00Z`),
});

test('an active plan wins over a newer pending attempt', async () => {
  const data = await statusFor([sub('orig', 'active', 27), sub('probe', 'pending', 28)]);
  assert.equal(data.currentStage, 3);
  assert.notEqual(data.status, 'Stage 2 - Payment Pending');
});

test('without an active plan, the newest open attempt is shown as Payment Pending', async () => {
  const data = await statusFor([sub('old', 'pending', 27), sub('newer', 'pending', 28)]);
  assert.equal(data.currentStage, 2);
  assert.equal(data.status, 'Stage 2 - Payment Pending');
});

test('expired or cancelled attempts are ignored, so the vendor can choose a plan again', async () => {
  const data = await statusFor([sub('a', 'expired', 27), sub('b', 'cancelled', 28)]);
  assert.equal(data.currentStage, 2);
  assert.equal(data.status, 'Stage 2 - Select Subscription Plan');
});

test('a newer expired attempt does not hide an older still-pending one', async () => {
  const data = await statusFor([sub('orig', 'pending', 27), sub('probe', 'expired', 28)]);
  assert.equal(data.status, 'Stage 2 - Payment Pending');
});

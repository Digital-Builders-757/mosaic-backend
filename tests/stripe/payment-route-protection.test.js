const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const paymentRoutesPath = path.resolve(__dirname, '../../routes/paymentRoutes.js');
const appPath = path.resolve(__dirname, '../../app.js');
const stripeRoutesPath = path.resolve(__dirname, '../../routes/stripe.routes.js');
const orderRoutesPath = path.resolve(__dirname, '../../routes/orderRoutes.js');
const paymentControllerPath = path.resolve(__dirname, '../../controllers/paymentController.js');
const ownershipPath = path.resolve(__dirname, '../../utils/stripeConnectOwnership.js');
const authenticatePath = path.resolve(__dirname, '../../middlewares/authenticate.js');
const checkoutBuyerPath = path.resolve(__dirname, '../../middlewares/isCheckoutBuyer.js');

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

test('legacy create-payment-intent router and controller are retired', () => {
  // The client-driven legacy PaymentIntent path (metadata only {orderId}, no
  // Connect transfer) bypassed the canonical checkout reservation. It is removed
  // rather than guarded so the release gate can prove an exclusive checkout surface.
  assert.equal(fs.existsSync(paymentRoutesPath), false);
  assert.equal(fs.existsSync(paymentControllerPath), false);
  const appSource = fs.readFileSync(appPath, 'utf8');
  assert.ok(!appSource.includes("app.use('/api/payments'"));
  assert.ok(!appSource.toLowerCase().includes('/create-payment-intent'));
});

test('stripe.routes wires auth middleware on Connect helper routes', () => {
  const source = fs.readFileSync(stripeRoutesPath, 'utf8');

  assert.match(source, /router\.post\('\/account-session', authenticate, isBusinessOwner/);
  assert.match(source, /router\.post\('\/express-login-link', authenticate, isBusinessOwner/);
  assert.match(source, /router\.get\('\/account-balance', authenticate, isBusinessOwner/);
  assert.match(source, /router\.get\('\/last-payout', authenticate, isBusinessOwner/);
  assert.match(source, /router\.post\('\/backfill-customers', authenticate, isAdmin/);
});

test('orderRoutes requires checkout-buyer role for initiate checkout', () => {
  const source = fs.readFileSync(orderRoutesPath, 'utf8');
  assert.match(source, /router\.post\('\/initiate', authenticate, isCheckoutBuyer, initiateOrder\)/);
});

for (const role of ['customer', 'business_owner']) {
  test(`checkout buyer gate allows ${role} without changing the authenticated user`, () => {
    const isCheckoutBuyer = require(checkoutBuyerPath);
    const user = { id: `${role}-id`, role };
    const req = { user };
    const res = mockResponse();
    let nextCalls = 0;

    isCheckoutBuyer(req, res, () => {
      nextCalls += 1;
    });

    assert.equal(nextCalls, 1);
    assert.equal(res.statusCode, null);
    assert.equal(req.user, user);
    assert.equal(req.user.role, role);
  });
}

for (const role of ['admin', 'unknown', undefined]) {
  test(`checkout buyer gate denies ${role ?? 'missing'} role with the existing response shape`, () => {
    const isCheckoutBuyer = require(checkoutBuyerPath);
    const res = mockResponse();
    let nextCalls = 0;

    isCheckoutBuyer({ user: role ? { role } : undefined }, res, () => {
      nextCalls += 1;
    });

    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: 'Access denied: Checkout buyers only' });
  });
}

test('authenticate rejects unauthenticated payment route access', async () => {
  const authenticate = require(authenticatePath);
  const res = mockResponse();
  let calledNext = false;

  await authenticate({ headers: {}, cookies: {} }, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 401);
});

test('assertConnectAccountOwnedByUser returns 403 for foreign Connect account', async () => {
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('models/Business')) {
      return {
        findOne: () => ({
          select: async () => null,
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[ownershipPath];
  const { assertConnectAccountOwnedByUser } = require(ownershipPath);
  Module._load = originalLoad;

  const result = await assertConnectAccountOwnedByUser('acct_foreign', '507f1f77bcf86cd799439012');
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('app.js keeps Stripe webhook raw-body mounts before express.json', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
  const jsonIndex = source.indexOf('app.use(express.json');
  const vendorWebhookIndex = source.indexOf("app.use('/api/vendor-onboarding/webhook/payment'");
  const stripeWebhookIndex = source.indexOf("app.use('/api/stripe'");

  assert.ok(jsonIndex > -1, 'express.json middleware must exist in app.js');
  assert.ok(vendorWebhookIndex > -1 && vendorWebhookIndex < jsonIndex);
  assert.ok(stripeWebhookIndex > -1 && stripeWebhookIndex < jsonIndex);
});

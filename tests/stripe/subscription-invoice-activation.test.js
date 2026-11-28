const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const helper = require('../../utils/subscriptionInvoiceActivation');

const controllerPath = path.resolve(__dirname, '../../controllers/subscriptionController.js');
const webhookPath = path.resolve(__dirname, '../../controllers/webhookController.js');

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
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeSubscriptionModel({ local = null, pending = null } = {}) {
  const calls = { findOne: [], findOneAndUpdate: [], saved: [] };
  let current = local ? { ...local } : null;

  function Subscription(doc) {
    Object.assign(this, doc, { _id: 'local_new' });
    this.save = async () => {
      calls.saved.push({ ...doc });
      return this;
    };
  }
  Subscription.findOne = (query) => {
    calls.findOne.push(query);
    const result = query.status === 'pending' ? pending : current;
    const promise = Promise.resolve(result);
    promise.sort = () => Promise.resolve(result);
    return promise;
  };
  Subscription.findOneAndUpdate = async (filter, update) => {
    calls.findOneAndUpdate.push({ filter, update });
    if (!current || current.status === 'active') return null;
    current = { ...current, ...update.$set };
    return current;
  };
  return { Subscription, calls };
}

function makeStripe({
  createdSubscription,
  retrievedSubscription,
  retrieveError,
  invoice,
} = {}) {
  const calls = {
    customersCreate: 0,
    subscriptionsCreate: [],
    subscriptionsRetrieve: [],
    subscriptionsCancel: [],
    paymentIntentsCreate: 0,
  };
  const client = {
    customers: {
      create: async () => {
        calls.customersCreate += 1;
        return { id: 'cus_new' };
      },
    },
    subscriptions: {
      create: async (params) => {
        calls.subscriptionsCreate.push(params);
        return createdSubscription;
      },
      retrieve: async (id, params) => {
        calls.subscriptionsRetrieve.push({ id, params });
        if (retrieveError) throw retrieveError;
        return { id, ...retrievedSubscription };
      },
      cancel: async (id) => {
        calls.subscriptionsCancel.push(id);
        return { id, status: 'canceled' };
      },
    },
    invoices: {
      retrieve: async (id) => ({ id, ...invoice }),
    },
    paymentIntents: {
      create: async () => {
        calls.paymentIntentsCreate += 1;
        return { id: 'pi_separate', client_secret: 'pi_separate_secret' };
      },
    },
    webhooks: {
      constructEvent: (payload) => JSON.parse(payload.toString()),
    },
  };
  return { client, calls };
}

function loadWithMocks(targetPath, { stripeClient, Subscription }) {
  const originalLoad = Module._load;
  const welcome = [];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'stripe') {
      return () => stripeClient;
    }
    if (request === '../models/Subscription') return Subscription;
    if (request === '../models/SubscriptionPlan') {
      return {
        findById: async () => ({ _id: 'plan_launch', price: 99, currency: 'usd', durationInDays: 365 }),
      };
    }
    if (request === '../helpers/stripePlan') {
      return { ensurePlanPrice: async () => ({ priceId: 'price_launch' }) };
    }
    if (request === '../utils/vendorTierWelcomeEmail') {
      return { triggerTierWelcomeNotifications: (sub) => welcome.push(sub) };
    }
    if (
      request === '../models/Order' ||
      request === '../models/User' ||
      request === '../lib/inventory/orderInventory' ||
      request === '../utils/sendOrderPaidConfirmation' ||
      request === '../utils/telnyxService'
    ) {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[targetPath];
  try {
    return { mod: require(targetPath), welcome };
  } finally {
    Module._load = originalLoad;
    delete require.cache[targetPath];
  }
}

const paidInvoice = (overrides = {}) => ({
  id: 'in_own',
  status: 'paid',
  parent: { subscription_details: { subscription: 'sub_own' } },
  ...overrides,
});

test('reads the subscription id from basil and legacy invoice shapes', () => {
  assert.equal(helper.subscriptionIdFromInvoice(paidInvoice()), 'sub_own');
  assert.equal(helper.subscriptionIdFromInvoice({ subscription: 'sub_legacy' }), 'sub_legacy');
  assert.equal(helper.subscriptionIdFromInvoice({ subscription: { id: 'sub_obj' } }), 'sub_obj');
  assert.equal(helper.subscriptionIdFromInvoice({ id: 'in_x' }), null);
  assert.equal(
    helper.invoiceClientSecret({ confirmation_secret: { client_secret: 'cs_own' } }),
    'cs_own'
  );
  assert.equal(helper.invoiceClientSecret({ payment_intent: { client_secret: 'pi_legacy_secret' } }), 'pi_legacy_secret');
  assert.equal(helper.invoiceClientSecret({}), null);
});

test('does not activate unless the invoice is paid and Stripe reports the subscription active', async () => {
  const { Subscription, calls } = makeSubscriptionModel({ local: { _id: 'local1', status: 'pending' } });

  const open = await helper.activateSubscriptionFromPaidInvoice({
    stripe: makeStripe({ retrievedSubscription: { status: 'active' } }).client,
    Subscription,
    invoice: paidInvoice({ status: 'open' }),
    logger: {},
  });
  assert.deepEqual(open, { activated: false, reason: 'invoice_not_paid' });

  const noSub = await helper.activateSubscriptionFromPaidInvoice({
    stripe: makeStripe({ retrievedSubscription: { status: 'active' } }).client,
    Subscription,
    invoice: { id: 'in_none', status: 'paid' },
    logger: {},
  });
  assert.equal(noSub.reason, 'no_subscription_on_invoice');
  assert.equal(calls.findOne.length, 0, 'never queries with an undefined subscription id');

  const incomplete = await helper.activateSubscriptionFromPaidInvoice({
    stripe: makeStripe({ retrievedSubscription: { status: 'incomplete' } }).client,
    Subscription,
    invoice: paidInvoice(),
    logger: {},
  });
  assert.equal(incomplete.reason, 'stripe_subscription_incomplete');
  assert.equal(calls.findOneAndUpdate.length, 0);
});

test('activates once from a paid invoice and is idempotent', async () => {
  const { Subscription, calls } = makeSubscriptionModel({ local: { _id: 'local1', status: 'pending' } });
  const stripe = makeStripe({ retrievedSubscription: { status: 'active' } }).client;
  const activated = [];

  const first = await helper.activateSubscriptionFromPaidInvoice({
    stripe, Subscription, invoice: paidInvoice(), onActivated: (s) => activated.push(s), logger: {},
  });
  const second = await helper.activateSubscriptionFromPaidInvoice({
    stripe, Subscription, invoice: paidInvoice(), onActivated: (s) => activated.push(s), logger: {},
  });

  assert.equal(first.activated, true);
  assert.equal(first.subscription.status, 'active');
  assert.equal(first.subscription.paymentStatus, 'COMPLETED');
  assert.equal(second.activated, false);
  assert.equal(second.reason, 'already_active');
  assert.equal(activated.length, 1, 'welcome notifications fire once');
  assert.deepEqual(calls.findOneAndUpdate[0].filter, { _id: 'local1', status: { $ne: 'active' } });
});

test('createSubscription returns the subscription invoice secret and never creates a separate PaymentIntent', async () => {
  const { Subscription, calls: modelCalls } = makeSubscriptionModel();
  const { client, calls } = makeStripe({
    createdSubscription: {
      id: 'sub_new',
      status: 'incomplete',
      latest_invoice: { id: 'in_new', status: 'open', confirmation_secret: { client_secret: 'in_new_cs' } },
    },
  });
  const { mod } = loadWithMocks(controllerPath, { stripeClient: client, Subscription });
  const res = mockResponse();

  await mod.createSubscription(
    { user: { _id: 'user1', email: 'qa@example.test', name: 'QA' }, body: { planId: 'plan_launch', applicationId: 'APP1' }, query: {} },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.clientSecret, 'in_new_cs');
  assert.equal(calls.paymentIntentsCreate, 0);
  assert.deepEqual(calls.subscriptionsCreate[0].expand, ['latest_invoice.confirmation_secret']);
  assert.equal(modelCalls.saved[0].status, 'pending');
  assert.equal(modelCalls.saved[0].stripeSubscriptionId, 'sub_new');
});

test('createSubscription fails closed and cancels when Stripe returns no invoice payment', async () => {
  const { Subscription, calls: modelCalls } = makeSubscriptionModel();
  const { client, calls } = makeStripe({
    createdSubscription: { id: 'sub_nopay', status: 'incomplete', latest_invoice: { id: 'in_x', status: 'open' } },
  });
  const { mod } = loadWithMocks(controllerPath, { stripeClient: client, Subscription });
  const res = mockResponse();
  const originalError = console.error;
  console.error = () => {};
  try {
    await mod.createSubscription(
      { user: { _id: 'user1', email: 'qa@example.test', name: 'QA' }, body: { planId: 'plan_launch' }, query: {} },
      res
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 502);
  assert.equal(calls.paymentIntentsCreate, 0);
  assert.deepEqual(calls.subscriptionsCancel, ['sub_nopay']);
  assert.equal(modelCalls.saved.length, 0);
});

test('createSubscription resumes a pending subscription and its open invoice instead of creating another', async () => {
  const { Subscription } = makeSubscriptionModel({
    pending: { _id: 'local_pending', status: 'pending', stripeSubscriptionId: 'sub_pending' },
  });
  const { client, calls } = makeStripe({
    retrievedSubscription: {
      status: 'incomplete',
      latest_invoice: { id: 'in_pending', status: 'open', confirmation_secret: { client_secret: 'in_pending_cs' } },
    },
  });
  const { mod } = loadWithMocks(controllerPath, { stripeClient: client, Subscription });
  const res = mockResponse();

  await mod.createSubscription(
    { user: { _id: 'user1', email: 'qa@example.test', name: 'QA' }, body: { planId: 'plan_launch', applicationId: 'APP1' }, query: {} },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.clientSecret, 'in_pending_cs');
  assert.equal(res.body.data.subscriptionId, 'local_pending');
  assert.equal(res.body.data.resumed, true);
  assert.equal(calls.customersCreate, 0);
  assert.equal(calls.subscriptionsCreate.length, 0);
  assert.equal(calls.paymentIntentsCreate, 0);
  assert.deepEqual(calls.subscriptionsRetrieve[0].params, { expand: ['latest_invoice.confirmation_secret'] });
});

async function runWebhook(event, { local, stripeStatus = 'active', invoice }) {
  process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = 'whsec_test';
  const { Subscription, calls: modelCalls } = makeSubscriptionModel({ local });
  const { client } = makeStripe({ retrievedSubscription: { status: stripeStatus }, invoice });
  const { mod, welcome } = loadWithMocks(webhookPath, { stripeClient: client, Subscription });
  const res = mockResponse();
  const originalLog = console.log;
  console.log = () => {};
  try {
    await mod.handleSubscriptionWebhook(
      { headers: { 'stripe-signature': 't=1,v1=x' }, body: Buffer.from(JSON.stringify(event)) },
      res
    );
  } finally {
    console.log = originalLog;
  }
  return { res, modelCalls, welcome };
}

test('webhook ignores charges and PaymentIntents tagged with a subscription id', async () => {
  for (const type of ['charge.succeeded', 'charge.updated', 'payment_intent.succeeded']) {
    const { res, modelCalls, welcome } = await runWebhook(
      { type, data: { object: { id: 'x', status: 'succeeded', metadata: { subscriptionId: 'sub_own' } } } },
      { local: { _id: 'local1', status: 'pending' } }
    );
    assert.equal(res.statusCode, 200, type);
    assert.equal(modelCalls.findOne.length, 0, `${type} does not look up the subscription`);
    assert.equal(modelCalls.findOneAndUpdate.length, 0, `${type} does not activate`);
    assert.equal(welcome.length, 0);
  }
});

test('webhook activates on invoice.paid and invoice.payment_succeeded for the subscription invoice', async () => {
  for (const type of ['invoice.paid', 'invoice.payment_succeeded']) {
    const { res, modelCalls, welcome } = await runWebhook(
      { type, data: { object: paidInvoice() } },
      { local: { _id: 'local1', status: 'pending' } }
    );
    assert.equal(res.statusCode, 200, type);
    assert.equal(modelCalls.findOneAndUpdate.length, 1, type);
    assert.equal(welcome.length, 1, type);
  }

  const stillIncomplete = await runWebhook(
    { type: 'invoice.paid', data: { object: paidInvoice() } },
    { local: { _id: 'local1', status: 'pending' }, stripeStatus: 'incomplete' }
  );
  assert.equal(stillIncomplete.modelCalls.findOneAndUpdate.length, 0);
  assert.equal(stillIncomplete.res.statusCode, 500, 'paid invoice + still-incomplete subscription asks Stripe to retry');
});

test('customer.subscription.updated activates only when its latest invoice is paid', async () => {
  const paid = await runWebhook(
    { type: 'customer.subscription.updated', data: { object: { id: 'sub_own', status: 'active', latest_invoice: 'in_own' } } },
    { local: { _id: 'local1', status: 'pending' }, invoice: paidInvoice() }
  );
  assert.equal(paid.res.statusCode, 200);
  assert.equal(paid.modelCalls.findOneAndUpdate.length, 1);

  const open = await runWebhook(
    { type: 'customer.subscription.updated', data: { object: { id: 'sub_own', status: 'active', latest_invoice: 'in_own' } } },
    { local: { _id: 'local1', status: 'pending' }, invoice: paidInvoice({ status: 'open' }) }
  );
  assert.equal(open.modelCalls.findOneAndUpdate.length, 0);
});

test('a declined first invoice keeps the record pending so checkout resumes it', async () => {
  for (const [billingReason, expected] of [['subscription_create', 'pending'], ['subscription_cycle', 'cancelled']]) {
    const saved = [];
    const local = { _id: 'local1', status: 'pending', paymentStatus: 'PENDING' };
    local.save = async function save() {
      saved.push({ status: this.status, paymentStatus: this.paymentStatus });
      return this;
    };
    const { res } = await runWebhook(
      { type: 'invoice.payment_failed', data: { object: paidInvoice({ status: 'open', billing_reason: billingReason }) } },
      { local }
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(saved, [{ status: expected, paymentStatus: 'FAILED' }], billingReason);
  }
});

test('resume never crosses applications and expires records Stripe no longer has', async () => {
  const { Subscription, calls: modelCalls } = makeSubscriptionModel({
    pending: { _id: 'local_pending', status: 'pending', stripeSubscriptionId: 'sub_gone' },
  });
  const missing = Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
  const { client, calls } = makeStripe({
    retrieveError: missing,
    createdSubscription: {
      id: 'sub_new',
      status: 'incomplete',
      latest_invoice: { id: 'in_new', status: 'open', confirmation_secret: { client_secret: 'in_new_cs' } },
    },
  });
  const { mod } = loadWithMocks(controllerPath, { stripeClient: client, Subscription });
  const res = mockResponse();

  await mod.createSubscription(
    { user: { _id: 'user1', email: 'qa@example.test', name: 'QA' }, body: { planId: 'plan_launch' }, query: {} },
    res
  );

  const pendingQuery = modelCalls.findOne.find((q) => q.status === 'pending');
  assert.equal(pendingQuery.applicationId, null, 'no application id only matches records without one');
  assert.deepEqual(modelCalls.findOneAndUpdate[0].update, { $set: { status: 'expired' } });
  assert.equal(res.statusCode, 201, 'falls through to a fresh subscription');
  assert.equal(calls.subscriptionsCreate.length, 1);
  assert.equal(calls.paymentIntentsCreate, 0);
});

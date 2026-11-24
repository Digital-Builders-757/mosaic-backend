const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ALLOWED_GET_PATHS,
  APPROVED_DECISION,
  buildDraftRecord,
  canonicalize,
  digestRecord,
  exportIntents,
  intentShape,
  reduceIntent,
  requireReadKey,
  sha256Hex,
  stripeGet,
  verifyStripeAccount,
} = require('../../scripts/release/legacy-payment-reconciliation');

const scriptPath = path.resolve(__dirname, '../../scripts/release/legacy-payment-reconciliation.js');
const ORDER_A = '64b000000000000000000001';
const ORDER_B = '64b000000000000000000002';
const ORDER_C = '64b000000000000000000003';

function intent(overrides) {
  return {
    id: 'pi_default',
    object: 'payment_intent',
    created: 1760000000,
    status: 'succeeded',
    amount: 2500,
    amount_received: 2500,
    currency: 'usd',
    livemode: false,
    metadata: {},
    transfer_data: null,
    application_fee_amount: null,
    latest_charge: 'ch_1',
    canceled_at: null,
    cancellation_reason: null,
    client_secret: 'pi_default_secret_MUST_NOT_EXPORT',
    receipt_email: 'buyer@example.test',
    description: 'should not export',
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const ACCOUNT_BODY = { object: 'account', id: 'acct_platform' };

// Routes GET /v1/account to the account body and serves list pages in order.
function stripeFake(pages, { account = ACCOUNT_BODY, requests = [] } = {}) {
  let pageIndex = 0;
  return async (url, options) => {
    requests.push({ url, options });
    if (new URL(url).pathname === '/v1/account') return jsonResponse(account);
    const page = pages[pageIndex];
    pageIndex += 1;
    return jsonResponse(page);
  };
}

test('script source never references a mutating Stripe surface or the SDK', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /require\(\s*['"]stripe['"]\s*\)/);
  assert.doesNotMatch(source, /method:\s*['"](POST|DELETE|PUT|PATCH)['"]/i);
  assert.doesNotMatch(source, /(paymentIntents|refunds|charges|transfers)\s*\./);
  assert.doesNotMatch(source, /\/refunds|\/cancel|\/capture|\/confirm/);
  assert.deepEqual(ALLOWED_GET_PATHS, ['/v1/payment_intents', '/v1/account']);
});

test('only restricted keys whose mode matches the requested account mode are accepted', () => {
  assert.equal(requireReadKey('rk_test_abc', 'test'), 'rk_test_abc');
  assert.equal(requireReadKey('rk_live_abc', 'live'), 'rk_live_abc');
  assert.throws(() => requireReadKey('sk_test_abc', 'test'), /restricted read key/);
  assert.throws(() => requireReadKey('sk_live_abc', 'live'), /restricted read key/);
  assert.throws(() => requireReadKey('rk_live_abc', 'test'), /does not match/);
  assert.throws(() => requireReadKey('rk_test_abc', 'live'), /does not match/);
  assert.throws(() => requireReadKey('', 'test'), /required/);
  assert.throws(() => requireReadKey('rk_test_abc', 'prod'), /test or live/);
});

test('stripeGet refuses non-allowlisted URLs before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({}); };
  for (const url of [
    'https://api.stripe.com/v1/refunds',
    'https://api.stripe.com/v1/payment_intents/pi_1/cancel',
    'https://api.stripe.com/v1/accounts/acct_1',
    'https://api.stripe.com/v1/accounts',
    'https://evil.example/v1/payment_intents',
    'https://evil.example/v1/account',
  ]) {
    await assert.rejects(() => stripeGet(fetchImpl, 'rk_test_x', new URL(url)), /allowlist/);
  }
  assert.equal(calls, 0);
});

test('export paginates with GET only, enforces livemode, and allowlists fields', async () => {
  const requests = [];
  const pages = [
    { object: 'list', has_more: true, data: [
      intent({ id: 'pi_b', metadata: { orderId: ORDER_A } }),
      intent({ id: 'pi_a', metadata: { orderId: ORDER_B, groupOrderId: 'g1' }, transfer_data: { destination: 'acct_v' }, application_fee_amount: 100 }),
    ] },
    { object: 'list', has_more: false, data: [
      intent({ id: 'pi_c', metadata: { subscriptionId: 'sub_1', userId: 'u' } }),
    ] },
  ];
  const fetchImpl = stripeFake(pages, { requests });
  const result = await exportIntents({
    key: 'rk_test_read',
    accountMode: 'test',
    stripeAccountId: 'acct_platform',
    createdGte: 1751328000,
    createdLte: 1790000000,
    fetchImpl,
    now: () => new Date('2026-11-24T00:00:00Z'),
  });
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[0].url).pathname, '/v1/account', 'account is verified before listing');
  assert.equal(requests[0].options.method, 'GET');
  for (const request of requests.slice(1)) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer rk_test_read');
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, 'https://api.stripe.com/v1/payment_intents');
    assert.equal(url.searchParams.get('created[gte]'), '1751328000');
    assert.equal(url.searchParams.get('created[lte]'), '1790000000');
  }
  assert.equal(new URL(requests[2].url).searchParams.get('starting_after'), 'pi_a');
  assert.equal(result.stripe.accountVerifiedBy, 'GET /v1/account');
  assert.deepEqual(result.intents.map((item) => item.paymentIntentId), ['pi_a', 'pi_b', 'pi_c']);
  assert.deepEqual(result.counts, { total: 3, legacy: 1, canonicalOrder: 1, other: 1 });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret|buyer@example|should not export/);

  await assert.rejects(() => exportIntents({
    key: 'rk_live_read',
    accountMode: 'live',
    stripeAccountId: 'acct_platform',
    fetchImpl: stripeFake([{ object: 'list', has_more: false, data: [intent({ id: 'pi_t', livemode: false })] }]),
  }), /livemode/);
});

test('export fails closed when a page claims has_more but carries no data', async () => {
  const exportWith = (pages) => exportIntents({
    key: 'rk_test_read',
    accountMode: 'test',
    stripeAccountId: 'acct_platform',
    createdGte: 1751328000,
    createdLte: 1790000000,
    fetchImpl: stripeFake(pages),
  });
  await assert.rejects(() => exportWith([
    { object: 'list', has_more: true, data: [] },
  ]), /has_more with an empty page/);
  await assert.rejects(() => exportWith([
    { object: 'list', has_more: true, data: [intent({ id: 'pi_a', metadata: { orderId: ORDER_A } })] },
    { object: 'list', has_more: true, data: [] },
  ]), /has_more with an empty page/);
  await assert.rejects(() => exportWith([
    { object: 'list', data: [] },
  ]), /Unexpected Stripe list response/);
  // An empty final page (has_more: false) is a legitimate empty window.
  const empty = await exportWith([{ object: 'list', has_more: false, data: [] }]);
  assert.equal(empty.counts.total, 0);
});

test('--stripe-account is verified against GET /v1/account before any listing', async () => {
  const requests = [];
  const run = (account, stripeAccountId = 'acct_platform') => exportIntents({
    key: 'rk_live_read',
    accountMode: 'live',
    stripeAccountId,
    createdGte: 1751328000,
    createdLte: 1790000000,
    fetchImpl: stripeFake([{ object: 'list', has_more: false, data: [] }], { account, requests }),
  });
  await assert.rejects(() => run({ object: 'account', id: 'acct_other' }), /belongs to acct_other, not --stripe-account acct_platform/);
  assert.equal(requests.length, 1, 'no PaymentIntent list call after an account mismatch');
  assert.equal(new URL(requests[0].url).pathname, '/v1/account');
  await assert.rejects(() => run({ object: 'list', data: [] }), /Unexpected Stripe account response/);
  await assert.rejects(() => run({ object: 'account' }), /Unexpected Stripe account response/);
  await assert.rejects(() => run(ACCOUNT_BODY, 'platform'), /acct_ id/);

  assert.equal(await verifyStripeAccount(stripeFake([]), 'rk_live_read', 'acct_platform'), 'acct_platform');
  const denied = async () => jsonResponse({ error: { type: 'invalid_request_error' } }, 403);
  await assert.rejects(() => verifyStripeAccount(denied, 'rk_live_read', 'acct_platform'), /GET \/v1\/account returned HTTP 403/);
});

test('legacy shape is exactly metadata {orderId} with no Connect transfer or fee', () => {
  assert.equal(intentShape(intent({ metadata: { orderId: ORDER_A } })), 'legacy');
  assert.equal(intentShape(intent({ metadata: { orderId: ORDER_A }, transfer_data: { destination: 'acct' } })), 'other');
  assert.equal(intentShape(intent({ metadata: { orderId: ORDER_A, groupOrderId: 'g' }, transfer_data: { destination: 'acct' } })), 'canonical-order');
  assert.equal(intentShape(intent({ metadata: { type: 'vendor_verification', userId: 'u' } })), 'other');
  assert.equal(intentShape(intent({ metadata: {} })), 'other');
});

function exportOf(intents) {
  return {
    schemaVersion: 1,
    kind: 'mosaic-legacy-payment-stripe-export',
    stripe: { accountId: 'acct_platform', accountMode: 'live', livemode: true },
    window: { createdGte: 1751328000, createdLte: 1790000000 },
    intents: intents.map((item) => reduceIntent({ livemode: true, ...item })),
  };
}

test('match classifies legacy intents and surfaces canonical intents orphaned by overwrite', () => {
  const stripeExport = exportOf([
    intent({ id: 'pi_legacy_paid', metadata: { orderId: ORDER_A } }),
    intent({ id: 'pi_legacy_open', status: 'requires_payment_method', amount_received: 0, metadata: { orderId: ORDER_B } }),
    intent({ id: 'pi_canonical_overwritten', metadata: { orderId: ORDER_B, groupOrderId: 'g' }, transfer_data: { destination: 'acct' }, application_fee_amount: 10, status: 'canceled' }),
    intent({ id: 'pi_canonical_ok', metadata: { orderId: ORDER_C, groupOrderId: 'g2' }, transfer_data: { destination: 'acct' }, application_fee_amount: 10 }),
    intent({ id: 'pi_legacy_orphan_paid', metadata: { orderId: ORDER_C } }),
    intent({ id: 'pi_subscription', metadata: { subscriptionId: 's' } }),
  ]);
  const orders = [
    { _id: { $oid: ORDER_A }, paymentId: 'pi_legacy_paid', paymentStatus: 'paid', status: 'confirmed' },
    { _id: ORDER_B, paymentId: 'pi_legacy_open', paymentStatus: 'pending', status: 'pending' },
    { _id: ORDER_C, paymentId: 'pi_canonical_ok', paymentStatus: 'paid', status: 'confirmed' },
  ];
  const record = buildDraftRecord({
    stripeExport,
    ordersExport: orders,
    stripeExportText: JSON.stringify(stripeExport),
    ordersExportText: JSON.stringify(orders),
  });
  const byId = Object.fromEntries(record.entries.map((entry) => [entry.paymentIntentId, entry]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'pi_canonical_overwritten', 'pi_legacy_open', 'pi_legacy_orphan_paid', 'pi_legacy_paid',
  ]);
  assert.equal(byId.pi_legacy_paid.category, 'settled-matched');
  assert.equal(byId.pi_legacy_open.category, 'outstanding-payable');
  assert.equal(byId.pi_canonical_overwritten.orphaned, true);
  assert.equal(byId.pi_canonical_overwritten.category, 'canceled');
  assert.equal(byId.pi_legacy_orphan_paid.category, 'settled-unmatched');
  assert.equal(record.counts.outstandingPayable, 1);
  assert.equal(record.counts.overwrittenCanonical, 1);
  assert.equal(record.review.decision, null);
  assert.match(record.sourceExports.stripeExportSha256, /^[a-f0-9]{64}$/);
});

test('canonical encoding is key-order independent and rejects ambiguous numbers', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalize({ a: { d: 1, c: 2 } }), canonicalize({ a: { c: 2, d: 1 } }));
  assert.throws(() => canonicalize({ amount: 25.5 }), /safe integers/);
  assert.throws(() => canonicalize({ a: undefined }), /undefined/);
  // Known vector: sha256 of the canonical bytes, reproducible with sha256sum.
  assert.equal(sha256Hex('{"a":1}'), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
});

function approvedRecord() {
  return {
    schemaVersion: 1,
    kind: 'mosaic-legacy-payment-reconciliation',
    stripe: { accountId: 'acct_platform', accountMode: 'live', livemode: true },
    window: { createdGte: 1751328000, createdLte: 1790000000 },
    sourceExports: { stripeExportSha256: 'a'.repeat(64), ordersExportSha256: 'b'.repeat(64) },
    counts: { entries: 2 },
    entries: [
      { paymentIntentId: 'pi_1', category: 'settled-matched', resolution: null },
      { paymentIntentId: 'pi_2', category: 'settled-unmatched', resolution: 'refunded-by-approved-operator' },
    ],
    review: {
      decision: APPROVED_DECISION,
      reviewers: ['reviewer-one'],
      reviewedAt: '2026-11-24T12:00:00Z',
      notes: null,
    },
  };
}

test('digest is deterministic and only produced for an approved, liability-free live record', () => {
  const record = approvedRecord();
  const first = digestRecord(record);
  const reordered = JSON.parse(JSON.stringify(record, Object.keys(record).reverse()));
  assert.equal(digestRecord({ ...reordered, ...record }).sha256, first.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256Hex(first.canonical), first.sha256);

  const open = approvedRecord();
  open.entries.push({ paymentIntentId: 'pi_3', category: 'outstanding-payable', resolution: null });
  assert.throws(() => digestRecord(open), /outstanding-payable/);

  const unresolved = approvedRecord();
  unresolved.entries[1].resolution = null;
  assert.throws(() => digestRecord(unresolved), /settled-unmatched/);

  const unreviewed = approvedRecord();
  unreviewed.review.decision = null;
  assert.throws(() => digestRecord(unreviewed), /review.decision/);

  const testMode = approvedRecord();
  testMode.stripe = { accountId: 'acct_platform', accountMode: 'test', livemode: false };
  assert.throws(() => digestRecord(testMode), /live-mode/);
  assert.match(digestRecord(testMode, { requireLive: false }).sha256, /^[a-f0-9]{64}$/);
});

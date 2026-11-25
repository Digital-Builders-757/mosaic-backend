const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  APPROVED_DECISION,
  DEPLOYMENT_STRIPE_MODES,
  canonicalize,
  digestRecord,
  main,
  sha256Hex,
} = require('../../scripts/release/legacy-payment-reconciliation');

const ACCOUNT = 'acct_1TestPlatform';

// Same fixture as approvedRecord() in legacyPaymentReconciliation.test.js.
function liveRecord() {
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

// Golden digest of liveRecord() computed with the tool at staging 9d97af4
// (before production test-mode attestation existed).
const LIVE_GOLDEN_SHA256 = 'a30028aa1e5e41d162f33fa57d11b25824c5a3778fdd0c7cec50f79ae70b0ef3';

function modeHistory(overrides = {}) {
  return {
    deploymentMode: 'test',
    account: ACCOUNT,
    evidence: [
      { source: 'stripe-dashboard', reference: 'Developers > API keys: no live keys ever created', checkedAt: '2026-11-24T10:00:00Z' },
      { source: 'aws-ssm-parameter-history', reference: '/mosaic/prod/STRIPE_SECRET_KEY history: only sk_test_ values', checkedAt: '2026-11-24T10:30:00Z' },
    ],
    livePaymentsEverConfigured: false,
    verifiedBy: 'reviewer-one',
    verifiedAt: '2026-11-24T11:00:00Z',
    ...overrides,
  };
}

function testRecord() {
  const record = liveRecord();
  record.stripe = { accountId: ACCOUNT, accountMode: 'test', livemode: false, accountVerifiedBy: 'GET /v1/account' };
  record.entries = record.entries.map((entry) => ({ ...entry, livemode: false }));
  record.review.stripeModeHistory = modeHistory();
  return record;
}

const TEST_FLAGS = { deploymentStripeMode: 'test', expectedStripeAccount: ACCOUNT };

test('live path is byte-identical to the pre-change golden digest', () => {
  const record = liveRecord();
  const result = digestRecord(record);
  assert.equal(result.sha256, LIVE_GOLDEN_SHA256);
  assert.equal(result.canonical, canonicalize(record));
  assert.doesNotMatch(result.canonical, /deploymentAttestation/);
  // An explicit "live" deployment mode is the same policy and the same bytes.
  assert.equal(digestRecord(record, { deploymentStripeMode: 'live' }).sha256, LIVE_GOLDEN_SHA256);
  assert.deepEqual(DEPLOYMENT_STRIPE_MODES, ['live', 'test']);
});

test('production test-mode attestation is accepted only with matching mode, account, and evidence', () => {
  const record = testRecord();
  const result = digestRecord(record, TEST_FLAGS);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256Hex(result.canonical), result.sha256);
  const parsed = JSON.parse(result.canonical);
  assert.deepEqual(parsed.deploymentAttestation, { deploymentStripeMode: 'test', expectedStripeAccount: ACCOUNT });
  assert.deepEqual(parsed.review.stripeModeHistory, modeHistory());
  // Deterministic and independent of the caller's record (no mutation).
  assert.equal(digestRecord(testRecord(), TEST_FLAGS).sha256, result.sha256);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'deploymentAttestation'), false);
  // The rehearsal digest of the same record differs from the attestation digest.
  assert.notEqual(digestRecord(testRecord(), { requireLive: false }).sha256, result.sha256);
});

test('test and live attestations of otherwise-identical entries never share a digest', () => {
  const live = liveRecord();
  live.stripe = { accountId: ACCOUNT, accountMode: 'live', livemode: true, accountVerifiedBy: 'GET /v1/account' };
  live.entries = live.entries.map((entry) => ({ ...entry, livemode: false }));
  live.review.stripeModeHistory = modeHistory();
  const testMode = testRecord();
  const liveDigest = digestRecord(live).sha256;
  const testDigest = digestRecord(testMode, TEST_FLAGS).sha256;
  assert.notEqual(liveDigest, testDigest);
  // Binding: the attestation block itself changes the hash, not only the stripe block.
  assert.notEqual(digestRecord(testRecord(), { requireLive: false }).sha256, testDigest);
});

test('test-mode record is refused when deployment mode is live or absent', () => {
  assert.throws(() => digestRecord(testRecord()), /live-mode record/);
  assert.throws(() => digestRecord(testRecord(), { deploymentStripeMode: 'live' }), /live-mode record/);
});

test('live record is refused under --deployment-stripe-mode test', () => {
  const record = testRecord();
  record.stripe = { ...record.stripe, accountMode: 'live', livemode: true };
  assert.throws(() => digestRecord(record, TEST_FLAGS), /Stripe mode mismatch/);
  const mixed = testRecord();
  mixed.stripe.accountMode = 'live';
  assert.throws(() => digestRecord(mixed, TEST_FLAGS), /Stripe mode mismatch/);
  const liveEntry = testRecord();
  liveEntry.entries[0].livemode = true;
  assert.throws(() => digestRecord(liveEntry, TEST_FLAGS), /pi_1 is not a test-mode entry/);
  const missingEntryMode = testRecord();
  delete missingEntryMode.entries[1].livemode;
  assert.throws(() => digestRecord(missingEntryMode, TEST_FLAGS), /pi_2 is not a test-mode entry/);
});

test('account mismatches and unverified accounts are refused', () => {
  assert.throws(() => digestRecord(testRecord(), { ...TEST_FLAGS, expectedStripeAccount: 'acct_other' }),
    /does not equal --expected-stripe-account acct_other/);
  const record = testRecord();
  record.stripe.accountId = 'acct_other';
  assert.throws(() => digestRecord(record, TEST_FLAGS), /stripe.accountId acct_other does not equal/);
  const history = testRecord();
  history.review.stripeModeHistory.account = 'acct_other';
  assert.throws(() => digestRecord(history, TEST_FLAGS), /stripeModeHistory.account must equal/);
  const unverified = testRecord();
  delete unverified.stripe.accountVerifiedBy;
  assert.throws(() => digestRecord(unverified, TEST_FLAGS), /accountVerifiedBy/);
});

test('malformed or missing expected account is a hard error', () => {
  for (const expectedStripeAccount of [undefined, '', 'acct_', 'platform', 'acct_bad-id', ' acct_x', 'acct_x\n']) {
    assert.throws(() => digestRecord(testRecord(), { deploymentStripeMode: 'test', expectedStripeAccount }),
      /requires --expected-stripe-account acct_<id>/, String(expectedStripeAccount));
  }
});

test('unknown deployment modes and partial flag sets are hard errors', () => {
  for (const deploymentStripeMode of ['', 'TEST', 'Test', 'sandbox', 'prod', 'live ', null, true]) {
    assert.throws(() => digestRecord(testRecord(), { deploymentStripeMode, expectedStripeAccount: ACCOUNT }),
      /must be exactly one of live, test/, String(deploymentStripeMode));
  }
  assert.throws(() => digestRecord(testRecord(), { expectedStripeAccount: ACCOUNT }),
    /only valid with --deployment-stripe-mode test/);
  assert.throws(() => digestRecord(liveRecord(), { deploymentStripeMode: 'live', expectedStripeAccount: ACCOUNT }),
    /only valid with --deployment-stripe-mode test/);
});

test('--allow-test-mode cannot be combined with production test-mode flags', () => {
  for (const flags of [
    TEST_FLAGS,
    { deploymentStripeMode: 'test' },
    { deploymentStripeMode: 'live' },
    { expectedStripeAccount: ACCOUNT },
  ]) {
    assert.throws(() => digestRecord(testRecord(), { requireLive: false, ...flags }), /cannot be combined/);
  }
});

test('each missing or inconsistent mode-history field is refused', () => {
  const cases = [
    ['missing block', (h) => undefined, /stripeModeHistory is required/],
    ['array block', () => [], /stripeModeHistory is required/],
    ['deploymentMode missing', (h) => { delete h.deploymentMode; return h; }, /deploymentMode must be exactly "test"/],
    ['deploymentMode live', (h) => ({ ...h, deploymentMode: 'live' }), /deploymentMode must be exactly "test"/],
    ['account missing', (h) => { delete h.account; return h; }, /account must equal/],
    ['evidence missing', (h) => { delete h.evidence; return h; }, /evidence must be a non-empty array/],
    ['evidence empty', (h) => ({ ...h, evidence: [] }), /evidence must be a non-empty array/],
    ['evidence not array', (h) => ({ ...h, evidence: 'see notion' }), /evidence must be a non-empty array/],
    ['evidence item not object', (h) => ({ ...h, evidence: ['x'] }), /evidence\[0\] must be an object/],
    ['evidence source missing', (h) => { delete h.evidence[0].source; return h; }, /evidence\[0\].source/],
    ['evidence source blank', (h) => { h.evidence[1].source = '  '; return h; }, /evidence\[1\].source/],
    ['evidence reference missing', (h) => { delete h.evidence[0].reference; return h; }, /evidence\[0\].reference/],
    ['evidence checkedAt missing', (h) => { delete h.evidence[0].checkedAt; return h; }, /evidence\[0\].checkedAt/],
    ['evidence checkedAt not ISO', (h) => { h.evidence[0].checkedAt = '1'; return h; }, /evidence\[0\].checkedAt/],
    ['livePaymentsEverConfigured missing', (h) => { delete h.livePaymentsEverConfigured; return h; }, /livePaymentsEverConfigured must be exactly false/],
    ['livePaymentsEverConfigured true', (h) => ({ ...h, livePaymentsEverConfigured: true }), /livePaymentsEverConfigured must be exactly false/],
    ['livePaymentsEverConfigured "false"', (h) => ({ ...h, livePaymentsEverConfigured: 'false' }), /livePaymentsEverConfigured must be exactly false/],
    ['verifiedBy missing', (h) => { delete h.verifiedBy; return h; }, /verifiedBy must name/],
    ['verifiedBy blank', (h) => ({ ...h, verifiedBy: '' }), /verifiedBy must name/],
    ['verifiedAt missing', (h) => { delete h.verifiedAt; return h; }, /verifiedAt must be an ISO-8601/],
    ['verifiedAt garbage', (h) => ({ ...h, verifiedAt: 'yesterday' }), /verifiedAt must be an ISO-8601/],
  ];
  for (const [name, mutate, expected] of cases) {
    const record = testRecord();
    const next = mutate(record.review.stripeModeHistory);
    if (next === undefined) delete record.review.stripeModeHistory;
    else record.review.stripeModeHistory = next;
    assert.throws(() => digestRecord(record, TEST_FLAGS), expected, name);
  }
});

test('existing review and blocker rules still apply under test-mode attestation', () => {
  const open = testRecord();
  open.entries.push({ paymentIntentId: 'pi_3', category: 'outstanding-payable', resolution: null, livemode: false });
  assert.throws(() => digestRecord(open, TEST_FLAGS), /outstanding-payable/);
  const unknown = testRecord();
  unknown.entries.push({ paymentIntentId: 'pi_4', category: 'unknown-status', resolution: null, livemode: false });
  assert.throws(() => digestRecord(unknown, TEST_FLAGS), /unknown-status/);
  const unresolved = testRecord();
  unresolved.entries[1].resolution = null;
  assert.throws(() => digestRecord(unresolved, TEST_FLAGS), /settled-unmatched/);
  const unreviewed = testRecord();
  unreviewed.review.decision = null;
  assert.throws(() => digestRecord(unreviewed, TEST_FLAGS), /review.decision/);
  const noReviewers = testRecord();
  noReviewers.review.reviewers = [];
  assert.throws(() => digestRecord(noReviewers, TEST_FLAGS), /review.reviewers/);
  const preBound = testRecord();
  preBound.deploymentAttestation = { deploymentStripeMode: 'test', expectedStripeAccount: ACCOUNT };
  assert.throws(() => digestRecord(preBound, TEST_FLAGS), /must not contain deploymentAttestation/);
});

test('CLI digest wires the new flags and fails closed on misuse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-testmode-'));
  const recordPath = path.join(dir, 'record.json');
  const canonicalPath = path.join(dir, 'record.canonical.json');
  fs.writeFileSync(recordPath, JSON.stringify(testRecord()));
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await main(['digest', '--record', recordPath, '--deployment-stripe-mode', 'test',
      '--expected-stripe-account', ACCOUNT, '--canonical-output', canonicalPath]);
    assert.equal(result.sha256, digestRecord(testRecord(), TEST_FLAGS).sha256);
    assert.equal(sha256Hex(fs.readFileSync(canonicalPath, 'utf8')), result.sha256);

    await assert.rejects(() => main(['digest', '--record', recordPath]), /live-mode record/);
    await assert.rejects(() => main(['digest', '--record', recordPath, '--allow-test-mode',
      '--deployment-stripe-mode', 'test', '--expected-stripe-account', ACCOUNT]), /cannot be combined/);
    await assert.rejects(() => main(['digest', '--record', recordPath, '--deployment-stripe-mode', 'sandbox',
      '--expected-stripe-account', ACCOUNT]), /must be exactly one of/);
    await assert.rejects(() => main(['digest', '--record', recordPath, '--deployment-stripe-mode', 'test']),
      /requires --expected-stripe-account/);
    await assert.rejects(() => main(['digest', '--record', recordPath, '--deployment-stripe-mode']), /requires a value/);
    await assert.rejects(() => main(['digest', '--record', recordPath, '--deployment-stripe-mode', 'test',
      '--deployment-stripe-mode', 'live', '--expected-stripe-account', ACCOUNT]), /more than once/);

    const livePath = path.join(dir, 'live.json');
    fs.writeFileSync(livePath, JSON.stringify(liveRecord()));
    const live = await main(['digest', '--record', livePath]);
    assert.equal(live.sha256, LIVE_GOLDEN_SHA256);
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

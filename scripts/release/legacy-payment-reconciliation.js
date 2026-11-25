#!/usr/bin/env node
'use strict';

// READ-ONLY reconciliation helper for PaymentIntents issued by the retired
// legacy route (POST /api/payments/create-payment-intent).
//
// Safety contract (enforced in code and covered by tests):
// - Stripe is only ever called with HTTP GET on allowlisted endpoints: the
//   PaymentIntents list and GET /v1/account (to prove which account the key
//   belongs to). There is no Stripe SDK import, so no mutating helper is
//   reachable.
// - --stripe-account is verified, not just a label: GET /v1/account must
//   return exactly that acct_ id before any PaymentIntent is listed.
// - Only restricted keys (rk_test_ / rk_live_) are accepted, and the key mode
//   must match --account-mode. Use a restricted key with PaymentIntents: Read
//   and nothing else.
// - Exported fields are allowlisted. client_secret, customer contact details,
//   descriptions, and payment-method details are never written.
// - The digest is SHA-256 over a deterministic canonical JSON encoding of the
//   reviewed record (see canonicalize()). It is the value an operator copies
//   into the LEGACY_PAYMENT_RECONCILIATION_SHA256 repository variable.
// - By default only a live-mode record is digested. A production deployment
//   that has only ever used Stripe test mode may instead attest with
//   `digest --deployment-stripe-mode test --expected-stripe-account acct_…`,
//   which additionally requires a reviewer-filled review.stripeModeHistory
//   block and binds mode + account into the hashed bytes. --allow-test-mode is
//   rehearsal-only and cannot be combined with those flags.
//
// See docs/release/LEGACY_PAYMENT_RECONCILIATION_PLAN.md for the procedure.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STRIPE_API_ORIGIN = 'https://api.stripe.com';
const ALLOWED_GET_PATHS = Object.freeze(['/v1/payment_intents', '/v1/account']);
const RECORD_KIND = 'mosaic-legacy-payment-reconciliation';
const EXPORT_KIND = 'mosaic-legacy-payment-stripe-export';
const APPROVED_DECISION = 'approved-no-outstanding-legacy-liability';
// The legacy route first shipped in commit c3e0c49 (2025-07-04). Start the
// default window a few days earlier so no early intent is missed.
const DEFAULT_CREATED_GTE = 1751328000; // 2025-07-01T00:00:00Z
const PAYABLE_STATUSES = Object.freeze([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
  'processing',
]);
const SETTLED_RESOLUTIONS = Object.freeze([
  'fulfilled-manually',
  'refunded-by-approved-operator',
  'duplicate-of-paid-order-refunded',
  'test-mode-only',
]);
const ORDER_ID = /^[a-f0-9]{24}$/i;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]+$/;
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
// Values accepted by `digest --deployment-stripe-mode`. "live" is the default
// live-only policy; "test" enables the production test-mode attestation.
const DEPLOYMENT_STRIPE_MODES = Object.freeze(['live', 'test']);

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('Canonical record numbers must be safe integers (use minor currency units)');
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      if (value[key] === undefined) throw new Error(`Canonical record field ${key} is undefined`);
      return `${JSON.stringify(key)}:${canonicalize(value[key])}`;
    }).join(',')}}`;
  }
  throw new Error(`Unsupported canonical value type: ${typeof value}`);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function requireReadKey(key, accountMode) {
  if (!['test', 'live'].includes(accountMode)) {
    throw new Error('--account-mode must be test or live');
  }
  const value = String(key || '');
  if (!value) throw new Error('STRIPE_RECONCILIATION_READ_KEY is required');
  if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(value)) {
    throw new Error('Only a restricted read key (rk_test_ or rk_live_) is accepted');
  }
  if (!value.startsWith(`rk_${accountMode}_`)) {
    throw new Error(`Restricted key mode does not match --account-mode ${accountMode}`);
  }
  return value;
}

function buildListUrl(query) {
  const url = new URL('/v1/payment_intents', STRIPE_API_ORIGIN);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  return url;
}

async function stripeGet(fetchImpl, key, url) {
  if (url.origin !== STRIPE_API_ORIGIN || !ALLOWED_GET_PATHS.includes(url.pathname)) {
    throw new Error('Refusing a Stripe request outside the read-only allowlist');
  }
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Stripe GET ${url.pathname} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function verifyStripeAccount(fetchImpl, key, expectedAccountId) {
  const body = await stripeGet(fetchImpl, key, new URL('/v1/account', STRIPE_API_ORIGIN));
  if (!body || body.object !== 'account' || typeof body.id !== 'string') {
    throw new Error('Unexpected Stripe account response');
  }
  if (body.id !== expectedAccountId) {
    throw new Error(`Restricted key belongs to ${body.id}, not --stripe-account ${expectedAccountId}`);
  }
  return body.id;
}

function metadataKeys(intent) {
  return Object.keys(intent.metadata || {}).sort();
}

function intentShape(intent) {
  const keys = metadataKeys(intent);
  const hasTransfer = Boolean(intent.transfer_data);
  const hasFee = intent.application_fee_amount !== null && intent.application_fee_amount !== undefined;
  if (keys.length === 1 && keys[0] === 'orderId' && !hasTransfer && !hasFee) return 'legacy';
  if (keys.includes('orderId') && keys.includes('groupOrderId')) return 'canonical-order';
  return 'other';
}

function reduceIntent(intent) {
  const metadataOrderId = intent.metadata && typeof intent.metadata.orderId === 'string'
    ? intent.metadata.orderId : null;
  return {
    paymentIntentId: intent.id,
    created: intent.created,
    status: intent.status,
    amount: intent.amount,
    amountReceived: intent.amount_received ?? 0,
    currency: intent.currency,
    livemode: intent.livemode === true,
    shape: intentShape(intent),
    metadataKeys: metadataKeys(intent),
    metadataOrderId,
    transferDataPresent: Boolean(intent.transfer_data),
    applicationFeePresent: intent.application_fee_amount !== null
      && intent.application_fee_amount !== undefined,
    latestChargeId: typeof intent.latest_charge === 'string' ? intent.latest_charge : null,
    canceledAt: intent.canceled_at ?? null,
    cancellationReason: intent.cancellation_reason ?? null,
  };
}

async function exportIntents({
  key,
  accountMode,
  stripeAccountId,
  createdGte = DEFAULT_CREATED_GTE,
  createdLte,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const readKey = requireReadKey(key, accountMode);
  if (!STRIPE_ACCOUNT_ID.test(String(stripeAccountId || ''))) {
    throw new Error('--stripe-account must be the acct_ id the key belongs to');
  }
  if (!Number.isSafeInteger(createdGte) || (createdLte !== undefined && !Number.isSafeInteger(createdLte))) {
    throw new Error('Created window bounds must be unix seconds');
  }
  const upperBound = createdLte ?? Math.floor(now().getTime() / 1000);
  await verifyStripeAccount(fetchImpl, readKey, stripeAccountId);
  const intents = [];
  let startingAfter;
  for (let page = 0; page < 10000; page += 1) {
    const body = await stripeGet(fetchImpl, readKey, buildListUrl({
      limit: 100,
      'created[gte]': createdGte,
      'created[lte]': upperBound,
      starting_after: startingAfter,
    }));
    if (!body || body.object !== 'list' || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') {
      throw new Error('Unexpected Stripe list response');
    }
    for (const intent of body.data) {
      if (!PAYMENT_INTENT_ID.test(String(intent.id || ''))) throw new Error('Unexpected PaymentIntent id');
      if ((intent.livemode === true) !== (accountMode === 'live')) {
        throw new Error('Stripe returned an object whose livemode differs from --account-mode');
      }
      intents.push(reduceIntent(intent));
    }
    if (body.has_more === true && body.data.length === 0) {
      // A page that claims more results but carries none would silently
      // truncate the enumeration; fail closed instead.
      throw new Error('Stripe returned has_more with an empty page; refusing a possibly truncated export');
    }
    if (body.has_more !== true) {
      startingAfter = undefined;
      break;
    }
    startingAfter = body.data[body.data.length - 1].id;
  }
  if (startingAfter) throw new Error('Pagination did not terminate');
  intents.sort((left, right) => left.paymentIntentId.localeCompare(right.paymentIntentId));
  return {
    schemaVersion: 1,
    kind: EXPORT_KIND,
    exportedAt: now().toISOString(),
    stripe: {
      accountId: stripeAccountId,
      accountMode,
      livemode: accountMode === 'live',
      accountVerifiedBy: 'GET /v1/account',
    },
    window: { createdGte, createdLte: upperBound },
    request: 'GET /v1/account; GET /v1/payment_intents?limit=100&created[gte]&created[lte] (auto-paginated)',
    counts: {
      total: intents.length,
      legacy: intents.filter((item) => item.shape === 'legacy').length,
      canonicalOrder: intents.filter((item) => item.shape === 'canonical-order').length,
      other: intents.filter((item) => item.shape === 'other').length,
    },
    intents,
  };
}

function normalizeOrders(ordersExport) {
  const list = Array.isArray(ordersExport) ? ordersExport : ordersExport?.orders;
  if (!Array.isArray(list)) throw new Error('Orders export must be an array or { orders: [] }');
  const byId = new Map();
  for (const order of list) {
    const rawId = order.orderId || order._id;
    const orderId = String(rawId && typeof rawId === 'object' ? rawId.$oid || '' : rawId || '');
    if (!ORDER_ID.test(orderId)) throw new Error('Orders export contains an invalid order id');
    byId.set(orderId.toLowerCase(), {
      orderId: orderId.toLowerCase(),
      paymentId: order.paymentId ? String(order.paymentId) : null,
      paymentStatus: order.paymentStatus ? String(order.paymentStatus) : null,
      status: order.status ? String(order.status) : null,
    });
  }
  return byId;
}

function classify(intent, order) {
  const referencedByOrder = Boolean(order && order.paymentId === intent.paymentIntentId);
  if (PAYABLE_STATUSES.includes(intent.status)) {
    return {
      category: 'outstanding-payable',
      requiredAction: 'Blocker: an approved operator must cancel this intent in Stripe (outside this tool), then re-export.',
      referencedByOrder,
    };
  }
  if (intent.status === 'canceled') {
    return { category: 'canceled', requiredAction: 'None.', referencedByOrder };
  }
  if (intent.status === 'succeeded') {
    if (referencedByOrder && order.paymentStatus === 'paid') {
      return { category: 'settled-matched', requiredAction: 'None.', referencedByOrder };
    }
    return {
      category: 'settled-unmatched',
      requiredAction: 'Human decision required: record fulfilment or approved refund as resolution.',
      referencedByOrder,
    };
  }
  return {
    category: 'unknown-status',
    requiredAction: 'Blocker: investigate this status manually before approval.',
    referencedByOrder,
  };
}

function buildDraftRecord({ stripeExport, ordersExport, stripeExportText, ordersExportText }) {
  if (stripeExport?.kind !== EXPORT_KIND || !Array.isArray(stripeExport.intents)) {
    throw new Error('Stripe export is not a legacy-payment export');
  }
  const orders = normalizeOrders(ordersExport);
  const entries = [];
  for (const intent of stripeExport.intents) {
    if (intent.shape === 'other') continue;
    const orderId = intent.metadataOrderId ? intent.metadataOrderId.toLowerCase() : null;
    const order = orderId ? orders.get(orderId) || null : null;
    const verdict = classify(intent, order);
    // Canonical intents only matter when a legacy call overwrote their order
    // reference (or the order is gone); matched canonical intents are covered
    // by the normal release reservation checks.
    if (intent.shape === 'canonical-order' && verdict.referencedByOrder) continue;
    entries.push({
      ...intent,
      orderFound: Boolean(order),
      orderPaymentId: order ? order.paymentId : null,
      orderPaymentStatus: order ? order.paymentStatus : null,
      orderStatus: order ? order.status : null,
      referencedByOrder: verdict.referencedByOrder,
      orphaned: !verdict.referencedByOrder,
      category: verdict.category,
      requiredAction: verdict.requiredAction,
      resolution: null,
      reviewerNote: null,
    });
  }
  entries.sort((left, right) => left.paymentIntentId.localeCompare(right.paymentIntentId));
  const count = (category) => entries.filter((entry) => entry.category === category).length;
  return {
    schemaVersion: 1,
    kind: RECORD_KIND,
    stripe: stripeExport.stripe,
    window: stripeExport.window,
    sourceExports: {
      stripeExportSha256: sha256Hex(stripeExportText),
      ordersExportSha256: sha256Hex(ordersExportText),
    },
    counts: {
      entries: entries.length,
      legacyShaped: entries.filter((entry) => entry.shape === 'legacy').length,
      overwrittenCanonical: entries.filter((entry) => entry.shape === 'canonical-order').length,
      orphaned: entries.filter((entry) => entry.orphaned).length,
      outstandingPayable: count('outstanding-payable'),
      settledMatched: count('settled-matched'),
      settledUnmatched: count('settled-unmatched'),
      canceled: count('canceled'),
      unknownStatus: count('unknown-status'),
    },
    entries,
    review: {
      decision: null,
      reviewers: [],
      reviewedAt: null,
      notes: null,
    },
  };
}

function validateReviewedRecord(record) {
  const problems = [];
  if (record?.kind !== RECORD_KIND || record.schemaVersion !== 1) {
    problems.push('Record is not a schemaVersion 1 legacy reconciliation record');
    return problems;
  }
  if (!Array.isArray(record.entries)) problems.push('Record entries are missing');
  for (const entry of record.entries || []) {
    if (['outstanding-payable', 'unknown-status'].includes(entry.category)) {
      problems.push(`${entry.paymentIntentId} is ${entry.category}; cancel/resolve in Stripe and re-export`);
    }
    if (entry.category === 'settled-unmatched' && !SETTLED_RESOLUTIONS.includes(entry.resolution)) {
      problems.push(`${entry.paymentIntentId} is settled-unmatched without an allowed resolution`);
    }
  }
  const review = record.review || {};
  if (review.decision !== APPROVED_DECISION) {
    problems.push(`review.decision must be ${APPROVED_DECISION}`);
  }
  if (!Array.isArray(review.reviewers) || review.reviewers.length < 1
      || review.reviewers.some((name) => typeof name !== 'string' || !name.trim())) {
    problems.push('review.reviewers must name at least one reviewer (GitHub handle)');
  }
  if (typeof review.reviewedAt !== 'string' || Number.isNaN(Date.parse(review.reviewedAt))) {
    problems.push('review.reviewedAt must be an ISO timestamp');
  }
  return problems;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Problems with the reviewer-filled review.stripeModeHistory block that a
// production test-mode attestation requires. A current sk_test_/rk_test_ key
// does not prove live payments were never configured, so a human must attest
// the deployment's Stripe mode history with checkable references.
function stripeModeHistoryProblems(history, expectedStripeAccount) {
  const prefix = 'review.stripeModeHistory';
  if (!history || typeof history !== 'object' || Array.isArray(history)) {
    return [`${prefix} is required for a production test-mode attestation`];
  }
  const problems = [];
  if (history.deploymentMode !== 'test') {
    problems.push(`${prefix}.deploymentMode must be exactly "test"`);
  }
  if (history.account !== expectedStripeAccount) {
    problems.push(`${prefix}.account must equal --expected-stripe-account ${expectedStripeAccount}`);
  }
  if (history.livePaymentsEverConfigured !== false) {
    problems.push(`${prefix}.livePaymentsEverConfigured must be exactly false`);
  }
  if (!isNonEmptyString(history.verifiedBy)) {
    problems.push(`${prefix}.verifiedBy must name the verifying reviewer (GitHub handle)`);
  }
  if (!isIsoTimestamp(history.verifiedAt)) {
    problems.push(`${prefix}.verifiedAt must be an ISO-8601 timestamp`);
  }
  if (!Array.isArray(history.evidence) || history.evidence.length < 1) {
    problems.push(`${prefix}.evidence must be a non-empty array of { source, reference, checkedAt }`);
  } else {
    history.evidence.forEach((item, index) => {
      const at = `${prefix}.evidence[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        problems.push(`${at} must be an object`);
        return;
      }
      if (!isNonEmptyString(item.source)) problems.push(`${at}.source must be a non-empty string`);
      if (!isNonEmptyString(item.reference)) problems.push(`${at}.reference must be a non-empty string`);
      if (!isIsoTimestamp(item.checkedAt)) problems.push(`${at}.checkedAt must be an ISO-8601 timestamp`);
    });
  }
  return problems;
}

// Resolves the digest policy from options. Fails closed: unknown modes and
// contradictory or partial flag combinations are hard errors, never a silent
// fallback. Returns null for the default live-only policy.
function resolveTestModeAttestation({ requireLive, deploymentStripeMode, expectedStripeAccount }) {
  const modeGiven = deploymentStripeMode !== undefined;
  const accountGiven = expectedStripeAccount !== undefined;
  if (!modeGiven && !accountGiven) return null;
  if (requireLive === false) {
    throw new Error('--allow-test-mode (rehearsal) cannot be combined with --deployment-stripe-mode / --expected-stripe-account');
  }
  if (modeGiven && !DEPLOYMENT_STRIPE_MODES.includes(deploymentStripeMode)) {
    throw new Error(`--deployment-stripe-mode must be exactly one of ${DEPLOYMENT_STRIPE_MODES.join(', ')}`);
  }
  if (deploymentStripeMode !== 'test') {
    if (accountGiven) {
      throw new Error('--expected-stripe-account is only valid with --deployment-stripe-mode test');
    }
    return null; // explicit "live": the unchanged live-only policy
  }
  if (!accountGiven || !STRIPE_ACCOUNT_ID.test(String(expectedStripeAccount))) {
    throw new Error('--deployment-stripe-mode test requires --expected-stripe-account acct_<id>');
  }
  return { deploymentStripeMode: 'test', expectedStripeAccount };
}

function digestRecord(record, { requireLive = true, deploymentStripeMode, expectedStripeAccount } = {}) {
  const attestation = resolveTestModeAttestation({ requireLive, deploymentStripeMode, expectedStripeAccount });
  const problems = validateReviewedRecord(record);
  if (!attestation) {
    if (requireLive && record?.stripe?.livemode !== true) {
      problems.push('Only a live-mode record may produce the production digest (use --allow-test-mode for rehearsal)');
    }
  } else {
    const stripe = record?.stripe || {};
    if (stripe.livemode !== false || stripe.accountMode !== 'test') {
      problems.push('Stripe mode mismatch: --deployment-stripe-mode test requires a test-mode record (stripe.livemode false, stripe.accountMode test)');
    }
    if (stripe.accountId !== attestation.expectedStripeAccount) {
      problems.push(`stripe.accountId ${stripe.accountId} does not equal --expected-stripe-account ${attestation.expectedStripeAccount}`);
    }
    if (stripe.accountVerifiedBy !== 'GET /v1/account') {
      problems.push('stripe.accountVerifiedBy must be "GET /v1/account" (account id verified at export)');
    }
    for (const entry of Array.isArray(record?.entries) ? record.entries : []) {
      if (entry.livemode !== false) {
        problems.push(`${entry.paymentIntentId} is not a test-mode entry (livemode must be false)`);
      }
    }
    if (record && Object.prototype.hasOwnProperty.call(record, 'deploymentAttestation')) {
      problems.push('Record must not contain deploymentAttestation; digest adds it');
    }
    problems.push(...stripeModeHistoryProblems(record?.review?.stripeModeHistory, attestation.expectedStripeAccount));
  }
  if (problems.length) {
    const error = new Error(`Record is not approvable:\n- ${problems.join('\n- ')}`);
    error.problems = problems;
    throw error;
  }
  // Live path: the record itself is hashed (unchanged). Test-mode attestation:
  // the deployment mode and expected account are bound into the hashed bytes,
  // so a test-mode digest can never equal a live digest of the same entries.
  const canonical = canonicalize(attestation ? { ...record, deploymentAttestation: attestation } : record);
  return { canonical, sha256: sha256Hex(canonical) };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new Error(`${name} given more than once`);
    if (name === '--allow-test-mode') {
      options[name] = true;
      continue;
    }
    if (rest[index + 1] === undefined) throw new Error(`${name} requires a value`);
    options[name] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return { text, json: JSON.parse(text) };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const { command, options } = parseCli(argv);
  const need = (name) => {
    if (!options[name]) throw new Error(`${name} is required`);
    return options[name];
  };
  if (command === 'export') {
    const result = await exportIntents({
      key: env.STRIPE_RECONCILIATION_READ_KEY,
      accountMode: need('--account-mode'),
      stripeAccountId: need('--stripe-account'),
      createdGte: options['--created-gte'] ? Number(options['--created-gte']) : DEFAULT_CREATED_GTE,
      createdLte: options['--created-lte'] ? Number(options['--created-lte']) : undefined,
      fetchImpl: dependencies.fetchImpl || fetch,
    });
    writeFile(need('--output'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Exported ${result.counts.total} PaymentIntents (${result.counts.legacy} legacy-shaped).`);
    return result;
  }
  if (command === 'match') {
    const stripeExport = readJson(need('--stripe-export'));
    const ordersExport = readJson(need('--orders-export'));
    const record = buildDraftRecord({
      stripeExport: stripeExport.json,
      ordersExport: ordersExport.json,
      stripeExportText: stripeExport.text,
      ordersExportText: ordersExport.text,
    });
    writeFile(need('--output'), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Draft record: ${JSON.stringify(record.counts)}`);
    return record;
  }
  if (command === 'digest') {
    const { json } = readJson(need('--record'));
    const result = digestRecord(json, {
      requireLive: !options['--allow-test-mode'],
      deploymentStripeMode: options['--deployment-stripe-mode'],
      expectedStripeAccount: options['--expected-stripe-account'],
    });
    if (options['--canonical-output']) writeFile(options['--canonical-output'], result.canonical);
    console.log(result.sha256);
    return result;
  }
  throw new Error('Usage: legacy-payment-reconciliation.js export|match|digest [options]');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Legacy payment reconciliation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_GET_PATHS,
  APPROVED_DECISION,
  DEFAULT_CREATED_GTE,
  DEPLOYMENT_STRIPE_MODES,
  PAYABLE_STATUSES,
  SETTLED_RESOLUTIONS,
  buildDraftRecord,
  canonicalize,
  classify,
  digestRecord,
  exportIntents,
  intentShape,
  main,
  reduceIntent,
  requireReadKey,
  sha256Hex,
  stripeGet,
  validateReviewedRecord,
  verifyStripeAccount,
};

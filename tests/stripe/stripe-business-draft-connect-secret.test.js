// /api/stripe/webhook: the platform destination (checkout.session.completed)
// and the connected-accounts destination (account.updated) use separate
// signing secrets. Synthetic secrets only.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_synthetic';
const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { verifyBusinessDraftEvent } = require('../../controllers/stripeController');

const stripe = new Stripe('sk_test_synthetic');
const PLATFORM = 'whsec_synthetic_platform';
const CONNECT = 'whsec_synthetic_connect';
const BOTH = { STRIPE_BUSINESS_DRAFT_WEBHOOK_SECRET: PLATFORM, STRIPE_BUSINESS_DRAFT_CONNECT_WEBHOOK_SECRET: CONNECT };

function signed(event, secret) {
  const payload = JSON.stringify(event);
  return { body: Buffer.from(payload), sig: stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}
const checkout = { id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: {} } };
const acctUpd = { id: 'evt_2', object: 'event', type: 'account.updated', account: 'acct_synthetic', data: { object: { id: 'acct_synthetic' } } };

test('platform checkout event verifies with the platform secret', () => {
  const { body, sig } = signed(checkout, PLATFORM);
  assert.equal(verifyBusinessDraftEvent(body, sig, BOTH, stripe).event.type, 'checkout.session.completed');
});

test('connected-account account.updated verifies with the connect secret', () => {
  const { body, sig } = signed(acctUpd, CONNECT);
  assert.equal(verifyBusinessDraftEvent(body, sig, BOTH, stripe).event.type, 'account.updated');
});

test('connect secret unset: platform-signed connected-account event is still accepted (unchanged behaviour)', () => {
  const { body, sig } = signed(acctUpd, PLATFORM);
  assert.equal(verifyBusinessDraftEvent(body, sig, { STRIPE_BUSINESS_DRAFT_WEBHOOK_SECRET: PLATFORM }, stripe).event.type, 'account.updated');
});

test('connect secret unset: connect-signed event is rejected', () => {
  const { body, sig } = signed(acctUpd, CONNECT);
  assert.ok(verifyBusinessDraftEvent(body, sig, { STRIPE_BUSINESS_DRAFT_WEBHOOK_SECRET: PLATFORM }, stripe).error);
});

test('connect-signed account.updated without an account field is rejected', () => {
  const { account, ...noAccount } = acctUpd;
  const { body, sig } = signed(noAccount, CONNECT);
  assert.ok(verifyBusinessDraftEvent(body, sig, BOTH, stripe).error);
});

test('whitespace around the connect secret is tolerated', () => {
  const { body, sig } = signed(acctUpd, CONNECT);
  const env = { ...BOTH, STRIPE_BUSINESS_DRAFT_CONNECT_WEBHOOK_SECRET: `  ${CONNECT}
` };
  assert.equal(verifyBusinessDraftEvent(body, sig, env, stripe).event.type, 'account.updated');
});

test('connect secret accepts only account.updated', () => {
  const { body, sig } = signed({ ...checkout, account: 'acct_synthetic' }, CONNECT);
  assert.ok(verifyBusinessDraftEvent(body, sig, BOTH, stripe).error);
});

test('connected-account event on the platform secret is rejected', () => {
  const { body, sig } = signed(acctUpd, PLATFORM);
  assert.ok(verifyBusinessDraftEvent(body, sig, BOTH, stripe).error);
});

test('bad signature is rejected', () => {
  const { body } = signed(checkout, PLATFORM);
  assert.ok(verifyBusinessDraftEvent(body, 't=1,v1=bad', BOTH, stripe).error);
});

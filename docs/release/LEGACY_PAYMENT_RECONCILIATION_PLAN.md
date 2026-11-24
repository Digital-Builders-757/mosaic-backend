# Legacy PaymentIntent reconciliation plan (read-only)

Status: plan + tooling, 2026-11-24. Nothing in this document writes to Stripe,
MongoDB, AWS, or GitHub settings. Every step that would change state is called
out as a **separate, human-approved action outside this procedure**.

## Why this exists

`POST /api/payments/create-payment-intent` (retired in the same PR as this
document) let an authenticated customer mint a payable PaymentIntent on the
**platform** Stripe account from an `orderId`, outside the canonical
`POST /api/orders/initiate` reservation path:

| Property | Legacy route (retired) | Canonical `/api/orders/initiate` |
| --- | --- | --- |
| `metadata` | exactly `{ orderId }` | `{ groupOrderId, orderId }` |
| `transfer_data` | absent | `{ destination: <vendor acct> }` |
| `application_fee_amount` | absent | platform fee |
| Order write | `order.paymentId = <new pi>` (**overwrites** any previous reference) | `order.paymentId = <pi>` |

Two liabilities follow, and the production release preflight cannot see either
from MongoDB alone:

1. **Legacy-shaped intents** may still be payable (`requires_payment_method`,
   etc.) or may have succeeded without a matching paid order.
2. **Overwrite orphans**: a legacy call on an order replaced its stored
   `paymentId`. The previous intent (legacy *or canonical*) is no longer
   referenced by any order, so the SSM reservation check cannot find it.

The production release workflow therefore requires the repository variable
`LEGACY_PAYMENT_RECONCILIATION_SHA256` = SHA-256 of a reviewed reconciliation
record (see `docs/release/RELEASE_CONTROL_INFRASTRUCTURE_SETUP.md`,
"Checkout-surface bootstrap prerequisite"). This plan defines that record and
how to produce its digest reproducibly.

## Order of operations

1. Merge the retirement PR into `staging`; it reaches Production only through
   the reviewed release path. Until the retired SHA is live, new legacy intents
   can still be created on Production **unless the checkout gate stays active**
   (today the ALB gate returns `503` on the legacy path).
2. Run this reconciliation **after** the legacy path is unreachable on
   Production (gate active, or retired SHA live), so the window is closed. Set
   `--created-lte` to a time after the path became unreachable.
3. Resolve every blocker entry with separately approved human actions (cancel
   payable intents, refund/fulfil unmatched succeeded intents) **outside this
   tool**, then re-export and re-match. The tool never performs those actions.
4. Review and sign the record, compute the digest, and hand the digest to the
   release owner, who sets `LEGACY_PAYMENT_RECONCILIATION_SHA256`. Setting the
   variable is a GitHub settings change and needs its own approval.

## Test vs live: keep them separate

| | Test rehearsal | Live (production digest) |
| --- | --- | --- |
| Stripe key | restricted `rk_test_…` | restricted `rk_live_…` |
| `--account-mode` | `test` | `live` |
| Mongo source | staging database, read-only user | production database, read-only user |
| Output folder | `recon/test/…` | `recon/live/…` |
| Digest | `--allow-test-mode` (rehearsal only, never put in the variable) | default; refuses non-live records |

The script refuses `sk_` keys, refuses a key whose mode differs from
`--account-mode`, and fails if Stripe returns any object whose `livemode`
differs from the requested mode. Never mix test and live files in one record.

### Restricted key

Create a restricted key on the **platform** account (legacy intents carry no
`transfer_data` and live only there) with exactly **PaymentIntents: Read**; all
other resources `None`. Give it a name such as `legacy-reconciliation-readonly`
and an expiry, keep it out of the repository and out of logs, pass it only via
the `STRIPE_RECONCILIATION_READ_KEY` environment variable, and roll it after
use. Creating/rolling the key is a Stripe dashboard action for the account
owner.

`--stripe-account` is **verified, not just a label**: before listing anything,
`export` calls `GET /v1/account` with the restricted key and refuses to continue
unless the returned `id` equals `--stripe-account` exactly. The export records
`stripe.accountVerifiedBy: "GET /v1/account"`. If Stripe denies that call to the
restricted key (HTTP 401/403), the export fails closed; grant the narrowest
**read** permission that allows retrieving the account itself (never a write
permission, never a Connect-wide permission) and re-run. Do not work around a
denial by dropping the check.

## Exact Stripe queries (GET only)

Authoritative enumeration uses the **List** endpoint (strongly consistent,
supports a `created` window). The script issues exactly:

```text
GET https://api.stripe.com/v1/account          # once; id must equal --stripe-account
Authorization: Bearer rk_<mode>_…

GET https://api.stripe.com/v1/payment_intents
    ?limit=100
    &created[gte]=<unix>          # default 1751328000 = 2025-07-01T00:00:00Z
    &created[lte]=<unix>          # close of window, after the path became unreachable
    [&starting_after=<last pi id>] # auto-pagination until has_more=false
Authorization: Bearer rk_<mode>_…
```

Pagination fails closed: a page with `has_more: true` and an empty `data` array,
or a page without a boolean `has_more`, aborts the export instead of silently
ending it (a truncated enumeration would understate the liability).

Equivalent manual call for a spot check (test account shown; use the live key
and identical parameters for live):

```bash
curl -G https://api.stripe.com/v1/payment_intents \
  -u "$STRIPE_RECONCILIATION_READ_KEY:" \
  -d limit=100 -d 'created[gte]=1751328000' -d 'created[lte]=<unix>'
```

Optional cross-check with the **Search** endpoint (eventually consistent, so it
is never the source of truth; it can be used to confirm one order's intents):

```bash
curl -G https://api.stripe.com/v1/payment_intents/search \
  -u "$STRIPE_RECONCILIATION_READ_KEY:" \
  --data-urlencode "query=metadata['orderId']:'<24-hex order id>'"
```

Search cannot express "metadata has only `orderId`", which is why the legacy
shape is classified locally from the List export.

Classification (`intentShape`):

- `legacy`: metadata keys are exactly `["orderId"]`, `transfer_data` absent,
  `application_fee_amount` absent.
- `canonical-order`: metadata contains both `orderId` and `groupOrderId`.
- `other`: everything else (subscriptions, vendor verification fee, …);
  counted in the export, excluded from the record.

## Fields exported

Only these fields are written (`reduceIntent`); `client_secret`, receipt email,
description, customer, shipping, and payment-method details are never exported:

`paymentIntentId`, `created`, `status`, `amount`, `amountReceived`, `currency`,
`livemode`, `shape`, `metadataKeys`, `metadataOrderId`, `transferDataPresent`,
`applicationFeePresent`, `latestChargeId`, `canceledAt`, `cancellationReason`.

## Orders export (MongoDB, read-only)

Use a read-only database user against the matching environment (staging for
test, production for live). Export only these fields:

```javascript
// mongosh, read-only user; collection is `orders` (model "Order")
const rows = db.orders.find(
  { paymentId: { $exists: true } },
  { _id: 1, paymentId: 1, paymentStatus: 1, status: 1 }
).toArray().map((o) => ({
  orderId: o._id.toHexString(),
  paymentId: o.paymentId || null,
  paymentStatus: o.paymentStatus || null,
  status: o.status || null,
}));
print(JSON.stringify(rows));
```

Also include orders whose ids appear as `metadataOrderId` in the Stripe export
but have no `paymentId` (add `{ _id: { $in: [...] } }` as an `$or` branch) so
"order missing" and "order without reference" are distinguishable.
`mongoexport --jsonArray` output (`{"_id":{"$oid":…}}`) is also accepted.

## Matching rules (`match`)

For every `legacy` intent, and every `canonical-order` intent whose order no
longer references it (overwrite orphan or missing order):

| Category | Condition | Required before approval |
| --- | --- | --- |
| `outstanding-payable` | status in `requires_payment_method`, `requires_confirmation`, `requires_action`, `requires_capture`, `processing` | **Blocker.** Cancel via a separately approved Stripe action, then re-export. |
| `unknown-status` | any other non-terminal status | **Blocker.** Investigate manually. |
| `settled-unmatched` | `succeeded` and (order missing, or order no longer references it, or order not `paid`) | Human decision; set `resolution` to one of `fulfilled-manually`, `refunded-by-approved-operator`, `duplicate-of-paid-order-refunded`, `test-mode-only`, plus `reviewerNote`. |
| `settled-matched` | `succeeded`, referenced by its order, order `paymentStatus: paid` | None. |
| `canceled` | `canceled` | None. |

`referencedByOrder` = the order with `_id == metadata.orderId` has
`paymentId == pi.id`; `orphaned` is its negation.

## Reviewed record format

`match` writes a draft (`schemaVersion: 1`, `kind:
"mosaic-legacy-payment-reconciliation"`):

```json
{
  "schemaVersion": 1,
  "kind": "mosaic-legacy-payment-reconciliation",
  "stripe": { "accountId": "acct_…", "accountMode": "live", "livemode": true },
  "window": { "createdGte": 1751328000, "createdLte": 1795000000 },
  "sourceExports": { "stripeExportSha256": "<64 hex>", "ordersExportSha256": "<64 hex>" },
  "counts": { "entries": 0, "legacyShaped": 0, "overwrittenCanonical": 0, "orphaned": 0,
              "outstandingPayable": 0, "settledMatched": 0, "settledUnmatched": 0,
              "canceled": 0, "unknownStatus": 0 },
  "entries": [ { "paymentIntentId": "pi_…", "category": "settled-matched",
                 "resolution": null, "reviewerNote": null, "…": "allowlisted fields" } ],
  "review": { "decision": null, "reviewers": [], "reviewedAt": null, "notes": null }
}
```

Reviewers fill only `entries[].resolution`, `entries[].reviewerNote`, and the
`review` block: `decision` must be exactly
`approved-no-outstanding-legacy-liability`, `reviewers` lists GitHub handles,
`reviewedAt` is an ISO timestamp. Amounts are integers in minor units. The
record contains no secrets or customer contact data, but it is still
production financial data.

### Where the reviewed record is stored

The reviewed `record.json` **and** its `record.canonical.json` are stored by the
release owner in the **Mosaic launch tracker** (the private Notion launch
tracker, linked from the release issue
`Digital-Builders-757/mosaic-biz-frontend-launch#498`), **never in the public
repository** and never in a PR, issue body, or workflow log. The release issue
references only the private artifact location and the digest. A second person
verifies by downloading both files from the tracker and recomputing the hash
with `digest` (and `sha256sum` on the canonical file), as described below.

## Digest (`LEGACY_PAYMENT_RECONCILIATION_SHA256`)

```bash
# live
STRIPE_RECONCILIATION_READ_KEY=rk_live_… node scripts/release/legacy-payment-reconciliation.js export \
  --account-mode live --stripe-account acct_… --created-lte <unix> --output recon/live/stripe-export.json
node scripts/release/legacy-payment-reconciliation.js match \
  --stripe-export recon/live/stripe-export.json --orders-export recon/live/orders.json \
  --output recon/live/record.json
# … resolve blockers out-of-band, re-export/re-match, then fill review fields …
node scripts/release/legacy-payment-reconciliation.js digest \
  --record recon/live/record.json --canonical-output recon/live/record.canonical.json
```

`digest` refuses the record if any entry is `outstanding-payable` /
`unknown-status`, any `settled-unmatched` entry lacks an allowed resolution, the
review block is incomplete, or the record is not live (rehearsals pass
`--allow-test-mode`; never use that output for the variable).

Canonicalization (deterministic, independently reproducible):

1. Objects: keys sorted by code unit (`Array.prototype.sort` order), no
   whitespace, `"key":value` joined by `,`.
2. Arrays: element order preserved (`entries` are pre-sorted by
   `paymentIntentId`).
3. Strings: `JSON.stringify` escaping. Numbers: safe integers only (floats are
   rejected). `true`/`false`/`null` literal. `undefined` is rejected.
4. Digest = lowercase hex SHA-256 of the UTF-8 bytes of that string, with **no
   trailing newline**.

Independent check: `sha256sum recon/live/record.canonical.json` must equal the
printed digest; a second reviewer can recompute from `record.json` with the
same script at the same commit.

**The digest is attestation-only.** It proves that the record the release
owner stored in the Mosaic launch tracker is byte-for-byte the record that was
reviewed; it does not itself check Stripe or MongoDB, and the release workflow
does not (and cannot) re-derive it from live data. Its value therefore depends
entirely on the reviewed record being retained in the tracker so anyone can
recompute it with `digest`. A digest whose record cannot be produced is not
evidence.

## What this procedure never does

- No Stripe writes (no cancel, refund, capture, update) and no SDK import; the
  only HTTP calls are `GET /v1/account` and `GET /v1/payment_intents`.
- No MongoDB writes; the orders export is produced by a read-only user.
- No GitHub variable changes; the release owner sets
  `LEGACY_PAYMENT_RECONCILIATION_SHA256` after review.
- It does not cover intents created on connected accounts (legacy intents are
  platform-only) or outside the `created` window; widen the window if in doubt.

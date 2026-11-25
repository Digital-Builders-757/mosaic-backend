# One-time legacy-retirement bootstrap (production release workflow)

Status: reviewed workflow mode, added 2026-11-24. It replaces the undocumented
"controlled prerequisite" in
[`RELEASE_CONTROL_INFRASTRUCTURE_SETUP.md`](RELEASE_CONTROL_INFRASTRUCTURE_SETUP.md#checkout-surface-bootstrap-prerequisite)
with an auditable path inside `Mosaic Production Release`, so the first retired
SHA never needs an out-of-band deploy or override.

## The circle it breaks

Normal `release` and break-glass `rollback` preflight require **all** of:

1. live `POST /api/payments/create-payment-intent` returns `404`/`405`;
2. `vars.LEGACY_PAYMENT_RETIREMENT_SHA` is a full SHA that is an ancestor of
   the **live** production SHA and of the target;
3. `vars.LEGACY_PAYMENT_RECONCILIATION_SHA256` is set;
4. the exact target tree/route table has no legacy route.

(1) and (2) can only be true *after* a retired SHA is live, and the workflow is
the only sanctioned way to make it live. Production today runs `9bc75c2`, which
mounts the route (currently masked by the active ALB checkout gate, `503`).

## What `legacy-retirement-bootstrap` requires

| Check | Where |
| --- | --- |
| `workflow_dispatch` only, phrase `BOOTSTRAP LEGACY PAYMENT RETIREMENT EXACT SHA` | `resolve-production-release.js` |
| Target == exact current `main` tip (same as `release`) | resolver, approval re-check, gate step |
| `vars.LEGACY_PAYMENT_RETIREMENT_SHA` **unset** (self-disabling) | resolver, public preflight, binding step, re-checked after approval |
| `vars.LEGACY_PAYMENT_RECONCILIATION_SHA256` is 64 **lowercase** hex (uppercase/mixed case is refused at the resolver, never case-folded) | resolver, public preflight, binding step, re-checked after approval |
| Canonical staging-promotion source certificate (cannot be skipped) | `verify-source` (`verify-main-release-source.js`) |
| Exact-SHA unit/contract/integration suites | `exact-ci` |
| Target route table: canonical `401`, every legacy spelling `404`/`405`, legacy POST route absent from the Express stack | `target-checkout-surface` |
| Target runtime sources contain no legacy/dynamic POST registration | `verify-checkout-surface-contract.js` |
| Live legacy route is `401` or `503` (pre-retirement); a live `404`/`405` refuses the bootstrap | `verify-production-public-surfaces.js --release-mode legacy-retirement-bootstrap` |
| Live SHA is an ancestor of the target; live **tree** still exposes the legacy route; target tree is exclusive | `verify-legacy-retirement-bootstrap.js` (Git only) |
| Read-only AWS topology and drain | `aws-preflight` (unchanged) |
| After approval, before any mutation: live SHA self-reported by `/api/build-info` equals the EB `VersionLabel` `mosaic-<sha>` from the re-run read-only topology preflight, and the Git binding is re-proven against it | approval job, `verify-legacy-retirement-bootstrap.js --eb-version-label` |
| **`production-release-control` environment approval** | unchanged mutating job |
| Dual-path ALB gate (orders/initiate **and** legacy path) active through deploy | `manage-checkout-gate.js` / `verify-checkout-gate.sh` in bootstrap mode |
| Zero reservation blockers before and after deploy | unchanged |
| After ungating: canonical `401`, legacy `404`/`405` on HTTP and HTTPS | `verify-checkout-gate.sh --state inactive`, public `ungated` proof |

The release, rollback, and focused-baseline code paths are unchanged; the new
checks only run when `release_mode == legacy-retirement-bootstrap`.

## Sequence

1. Merge the retirement PR and this PR into `staging`; the certified staging →
   `main` release PR carries both. Merging that PR into `main` starts the
   normal push-triggered `release` run, which **stops at public preflight**
   (no `LEGACY_PAYMENT_RETIREMENT_SHA`, live legacy route not `404`). No AWS
   mutation happens.
2. Complete the read-only reconciliation in
   [`LEGACY_PAYMENT_RECONCILIATION_PLAN.md`](LEGACY_PAYMENT_RECONCILIATION_PLAN.md)
   and have the release owner set `LEGACY_PAYMENT_RECONCILIATION_SHA256`.
   Leave `LEGACY_PAYMENT_RETIREMENT_SHA` unset. Production on Stripe test keys
   uses the
   [test-mode production attestation](LEGACY_PAYMENT_RECONCILIATION_PLAN.md#production-in-stripe-test-mode)
   (`digest --deployment-stripe-mode test --expected-stripe-account acct_…`).
3. Dispatch `Mosaic Production Release` with `mode=legacy-retirement-bootstrap`,
   `release_sha=<exact main tip>`, and the bootstrap phrase as `confirmation`.
4. Review the preflight evidence (`legacy-retirement-bootstrap.json`,
   `public-preflight.json`) and approve `production-release-control`.
5. On success the run summary prints the required follow-up: the release owner
   sets `LEGACY_PAYMENT_RETIREMENT_SHA=<deployed SHA>`. From then on the
   bootstrap is refused everywhere (resolver, preflight, binding, approval),
   and only `release`/`rollback` apply. Even if the variable were forgotten,
   the binding step refuses because the live tree no longer exposes the route.

Approving the bootstrap opens checkout exactly as a normal release does (the
gate is disabled after the retired build is verified). If checkout must stay
closed, do not approve; that is a product decision, not a workflow option.

## Rollback mode and what becomes valid

- **Before the bootstrap:** workflow rollback cannot pass at all. It runs the
  same target route proof (no legacy route) and the retirement ancestry
  binding, and `LEGACY_PAYMENT_RETIREMENT_SHA` is unset. In particular a
  workflow rollback to `9bc75c2` is impossible, by design, because it would
  re-expose the legacy route.
- **After the bootstrap with `LEGACY_PAYMENT_RETIREMENT_SHA = R`:** a rollback
  target `T` is valid only if `T` is reachable from current `main`, `R` is an
  ancestor of `T` (so `T = R` or any later main commit), `T` is not already
  live, and `T`'s tree/route table has no legacy route. Rolling back to
  anything older than `R` is permanently refused.
- Workflow rollback passes `--release-mode "$RELEASE_MODE"` explicitly;
  `manage-checkout-gate.js verify` and `verify-checkout-gate.sh` accept an
  explicit `rollback` and map it to the canonical release gate (#391).

## Failure handling

- Any failure after the gate is enabled re-asserts the **dual-path** gate
  (fail-safe), so neither initiator reopens.
- If EB deployment completed but a later proof failed, the live tree no longer
  mounts the legacy route, so the bootstrap refuses to re-run. Recover by
  recording `LEGACY_PAYMENT_RETIREMENT_SHA` (only after verifying the live SHA
  and `404`/`405`) and shipping the next certified `main` commit through the
  normal release path, or follow `CHECKOUT_GATE_OPERATIONS.md` with explicit
  human approval.

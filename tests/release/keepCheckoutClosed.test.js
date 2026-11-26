'use strict';

// Regression tests for the keep-closed production release policy: a release
// (including the one-time legacy-retirement bootstrap) must leave the checkout
// gate active unless an operator explicitly dispatches checkout_after_release=open.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gateApi = require('../../scripts/release/manage-checkout-gate');
const { buildProductionEvidence, parseArgs } = require('../../scripts/release/build-production-evidence');

const repoRoot = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy-eb-production.yml'), 'utf8');

const REGION = 'us-east-1';
const ACCOUNT = '123456789012';
const LOAD_BALANCER_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/prod/abc123`;
const HTTP_LISTENER_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/prod/abc123/http80`;
const HTTPS_LISTENER_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/prod/abc123/https443`;
const HTTP_RULE_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener-rule/app/prod/abc123/http80/rule1`;
const HTTPS_RULE_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener-rule/app/prod/abc123/https443/rule2`;
const SHA = 'a'.repeat(40);
const LIVE = 'b'.repeat(40);

// --- workflow structure -----------------------------------------------------

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `workflow step "${name}" is missing`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  const jobEnd = workflow.indexOf('\n  release-summary:', start);
  const end = [next, jobEnd].filter((index) => index > start).reduce((a, b) => Math.min(a, b), workflow.length);
  return workflow.slice(start, end);
}

test('checkout policy defaults to keep-closed and only an explicit dispatch can choose open', () => {
  assert.match(
    workflow,
    /checkout_after_release:\n {8}description: [^\n]+\n {8}required: true\n {8}type: choice\n {8}options:\n {10}- keep-closed\n {10}- open\n {8}default: keep-closed\n/
  );
  const policy = step('Resolve post-release checkout policy');
  assert.match(
    policy,
    /REQUESTED_CHECKOUT_POLICY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.checkout_after_release \|\| 'keep-closed' \}\}/
  );
  assert.match(policy, /keep-closed\|open\) ;;/);
  assert.match(policy, /\*\) echo "::error::checkout_after_release must be keep-closed or open"; exit 1 ;;/);
  assert.match(workflow, /checkout_after_release: \$\{\{ steps\.checkout-policy\.outputs\.checkout_after_release \}\}/);
});

test('the only gate-disable command in the release workflow runs solely under checkout_after_release == open', () => {
  const disables = workflow.match(/manage-checkout-gate\.js disable/g) || [];
  assert.equal(disables.length, 1, 'exactly one gate disable command is allowed');
  assert.equal((workflow.match(/DISABLE_CHECKOUT_GATE/g) || []).length, 1, 'exactly one disable confirmation is allowed');
  const ungate = step('Disable exact checkout gate');
  assert.match(ungate, /manage-checkout-gate\.js disable/);
  assert.match(ungate, /if: \$\{\{ [^\n]*needs\.resolve-release\.outputs\.checkout_after_release == 'open' [^\n]*\}\}/);
  assert.doesNotMatch(ungate, /\|\|/, 'no alternative condition may reach the disable step');
  const openProof = step('Prove normal checkout and exact production health');
  assert.match(openProof, /needs\.resolve-release\.outputs\.checkout_after_release == 'open'/);
  assert.doesNotMatch(workflow, /--state inactive[\s\S]*--state inactive/, 'single inactive proof, inside the open path');
});

test('keep-closed release narrows the bootstrap gate and proves initiate 503 with the retired route gone', () => {
  const narrow = step('Narrow bootstrap gate to the retired build without opening checkout');
  assert.match(narrow, /release_mode == 'legacy-retirement-bootstrap' && needs\.resolve-release\.outputs\.checkout_after_release == 'keep-closed'/);
  assert.match(narrow, /manage-checkout-gate\.js narrow/);
  assert.match(narrow, /--confirm NARROW_CHECKOUT_GATE/);

  const kept = step('Prove checkout stays closed on the exact release');
  assert.match(kept, /id: kept-closed/);
  assert.match(kept, /env:\n\s+(?:#[^\n]*\n\s+)*RELEASE_MODE: release\n/);
  assert.match(kept, /release_mode != 'focused-baseline' && needs\.resolve-release\.outputs\.checkout_after_release == 'keep-closed'/);
  assert.match(kept, /manage-checkout-gate\.js verify \\\n\s+--release-mode release \\\n\s+--expected-state active/);
  assert.match(kept, /verify-checkout-gate\.sh \\\n\s+--release-mode release/);
  assert.doesNotMatch(kept, /--state inactive/);
  assert.match(kept, /verify-production-public-surfaces\.js \\\n\s+--mode deployed \\\n\s+--release-mode release/);
  assert.match(kept, /--expected-sha "\$RELEASE_SHA"/);
  assert.match(kept, /safe_gated=true/);
  assert.ok(workflow.indexOf('id: narrow') < workflow.indexOf('id: kept-closed'), 'narrow precedes the kept-closed proof');
  assert.ok(workflow.indexOf('id: kept-closed') > workflow.indexOf('id: final-open'));
});

test('fail-safe re-gating still covers every unproven ending, including a failed keep-closed proof', () => {
  const condition = "${{ always() && steps.gate.outputs.attempted == 'true' && steps.final-open.outputs.safe_open != 'true' && steps.kept-closed.outputs.safe_gated != 'true' }}";
  assert.equal(workflow.split(condition).length - 1, 2);
  assert.ok(step('Refresh AWS credentials for fail-safe gate control').includes(`if: ${condition}`));
  assert.ok(step('Reassert safe gate after any post-enable failure').includes(`if: ${condition}`));
});

test('both evidence builders receive the resolved checkout policy', () => {
  const calls = workflow.match(/build-production-evidence\.js \\\n(?:\s+--[^\n]+\\\n)+\s+--output [^\n]+/g) || [];
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call, /--checkout-after-release "\$CHECKOUT_AFTER_RELEASE"/);
  assert.match(workflow, /CHECKOUT_AFTER_RELEASE: \$\{\{ needs\.resolve-release\.outputs\.checkout_after_release \}\}/);
  assert.match(workflow, /CHECKOUT_AFTER_RELEASE: \$\{\{ needs\.resolve-release\.outputs\.checkout_after_release \|\| 'keep-closed' \}\}/);
});

// --- gate narrowing ---------------------------------------------------------

function gateFixture(releaseMode, httpMode = releaseMode) {
  const rule = (ruleArn, mode) => ({
    RuleArn: ruleArn,
    Priority: '1',
    IsDefault: false,
    Conditions: gateApi.gateConditions(gateApi.ACTIVE_PATH, mode),
    Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '503' } }],
  });
  const tag = (ResourceArn) => ({ ResourceArn, Tags: [{ Key: gateApi.REQUIRED_TAG_KEY, Value: gateApi.REQUIRED_TAG_VALUE }] });
  return {
    loadBalancers: { LoadBalancers: [{ LoadBalancerArn: LOAD_BALANCER_ARN, LoadBalancerName: 'prod', Type: 'application', Scheme: 'internet-facing', State: { Code: 'active' } }] },
    listeners: {
      Listeners: [
        { ListenerArn: HTTP_LISTENER_ARN, LoadBalancerArn: LOAD_BALANCER_ARN, Port: 80, Protocol: 'HTTP' },
        { ListenerArn: HTTPS_LISTENER_ARN, LoadBalancerArn: LOAD_BALANCER_ARN, Port: 443, Protocol: 'HTTPS' },
      ],
    },
    rulesByListener: {
      [HTTP_LISTENER_ARN]: { Rules: [rule(HTTP_RULE_ARN, httpMode)] },
      [HTTPS_LISTENER_ARN]: { Rules: [rule(HTTPS_RULE_ARN, releaseMode)] },
    },
    tags: { TagDescriptions: [tag(HTTP_RULE_ARN), tag(HTTPS_RULE_ARN)] },
  };
}

function gateConfig(releaseMode) {
  return {
    releaseMode,
    region: REGION,
    loadBalancerArn: LOAD_BALANCER_ARN,
    httpRuleArn: HTTP_RULE_ARN,
    httpsRuleArn: HTTPS_RULE_ARN,
    httpPriority: '1',
    httpsPriority: '1',
    disabledPath: gateApi.DEFAULT_DISABLED_PATH,
    tagKey: gateApi.REQUIRED_TAG_KEY,
    tagValue: gateApi.REQUIRED_TAG_VALUE,
  };
}

function regexValues(client, ruleArn) {
  const rules = Object.values(client.read().rulesByListener).flatMap((response) => response.Rules);
  const rule = rules.find((candidate) => candidate.RuleArn === ruleArn);
  const pathCondition = rule.Conditions.find((condition) => condition.Field === 'path-pattern');
  return (pathCondition.PathPatternConfig && pathCondition.PathPatternConfig.RegexValues) || [];
}

function watchedClient(fixture) {
  const client = gateApi.createFixtureGateClient(fixture);
  const observations = [];
  const order = [];
  const modifyRule = client.modifyRule.bind(client);
  client.modifyRule = (ruleArn, pathValue, releaseMode) => {
    order.push(ruleArn);
    modifyRule(ruleArn, pathValue, releaseMode);
    // After every single ALB mutation, both rules must still block initiate.
    observations.push([HTTP_RULE_ARN, HTTPS_RULE_ARN].every((arn) =>
      regexValues(client, arn).includes(gateApi.ACTIVE_PATH_REGEX)));
  };
  return { client, observations, order };
}

test('narrow keeps initiate blocked at every mutation and leaves the canonical release gate active', () => {
  const { client, observations, order } = watchedClient(gateFixture('legacy-retirement-bootstrap'));
  const result = gateApi.narrowGate(client, gateConfig('legacy-retirement-bootstrap'));
  assert.equal(result.operation, 'narrowed');
  assert.deepEqual(order, [HTTPS_RULE_ARN, HTTP_RULE_ARN], 'HTTPS is narrowed first');
  assert.equal(result.gateState, 'active');
  assert.deepEqual(observations, [true, true]);
  // Every later release and rollback reads this shape as an active gate.
  assert.equal(gateApi.verifyGate(client, 'active', gateConfig('release')).gateState, 'active');
  assert.deepEqual(regexValues(client, HTTPS_RULE_ARN), [gateApi.ACTIVE_PATH_REGEX]);
  assert.deepEqual(regexValues(client, HTTP_RULE_ARN), [gateApi.ACTIVE_PATH_REGEX]);
  // Idempotent re-run performs no mutation.
  assert.equal(gateApi.narrowGate(client, gateConfig('legacy-retirement-bootstrap')).operation, 'idempotent-narrowed');
  assert.equal(observations.length, 2);
});

test('narrow resumes an interrupted attempt (one listener already narrowed)', () => {
  const { client, observations } = watchedClient(gateFixture('release', 'legacy-retirement-bootstrap'));
  const result = gateApi.narrowGate(client, gateConfig('legacy-retirement-bootstrap'));
  assert.equal(result.gateState, 'active');
  assert.deepEqual(observations, [true]);
});

test('narrow refuses an inactive gate, a non-bootstrap mode, and recovers the dual gate on failure', () => {
  const inactive = gateFixture('legacy-retirement-bootstrap');
  for (const response of Object.values(inactive.rulesByListener)) {
    response.Rules[0].Conditions = gateApi.gateConditions(gateApi.DEFAULT_DISABLED_PATH, 'legacy-retirement-bootstrap');
  }
  assert.throws(() => gateApi.narrowGate(gateApi.createFixtureGateClient(inactive), gateConfig('legacy-retirement-bootstrap')),
    /not active|not an active gate rule/);
  assert.throws(() => gateApi.narrowGate(gateApi.createFixtureGateClient(gateFixture('release')), gateConfig('release')),
    /only valid for the legacy-retirement-bootstrap gate/);

  const failing = gateFixture('legacy-retirement-bootstrap');
  failing.failOnModifyCall = 2;
  const client = gateApi.createFixtureGateClient(failing);
  assert.throws(() => gateApi.narrowGate(client, gateConfig('legacy-retirement-bootstrap')),
    (error) => /fail-safe recovery left the dual-path checkout gate active/.test(error.message) && error.gateState === 'active');
  assert.equal(gateApi.verifyGate(client, 'active', gateConfig('legacy-retirement-bootstrap')).gateState, 'active');
});

test('narrow requires its own confirmation phrase outside fixtures', () => {
  const env = {
    CHECKOUT_GATE_LOAD_BALANCER_ARN: LOAD_BALANCER_ARN,
    CHECKOUT_GATE_HTTP_RULE_ARN: HTTP_RULE_ARN,
    CHECKOUT_GATE_HTTPS_RULE_ARN: HTTPS_RULE_ARN,
    CHECKOUT_GATE_HTTP_PRIORITY: '1',
    CHECKOUT_GATE_HTTPS_PRIORITY: '1',
  };
  const argv = ['narrow', '--release-mode', 'legacy-retirement-bootstrap', '--output', 'x.json'];
  assert.throws(() => gateApi.cliConfiguration([...argv, '--confirm', 'DISABLE_CHECKOUT_GATE'], env), /narrow requires --confirm NARROW_CHECKOUT_GATE/);
  assert.equal(gateApi.cliConfiguration([...argv, '--confirm', 'NARROW_CHECKOUT_GATE'], env).action, 'narrow');
});

// --- release evidence -------------------------------------------------------

function write(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value)}\n`);
}

function keptClosedRun(t, { mode = 'legacy-retirement-bootstrap', legacyStatus = 404, narrowed = true, disabled = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-keep-closed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  write(directory, 'release-identity.json', { releaseSha: SHA, mode });
  write(directory, 'aws-approved-preflight.json', {
    status: 'passed', releaseSha: SHA, environmentState: 'Ready/Green/Ok', currentVersion: `mosaic-${LIVE}`,
    topology: { deploymentPolicy: 'AllAtOnce', minSize: 1, maxSize: 1, instanceCount: 1 },
    loadBalancer: { healthyTargetCount: 1 },
  });
  write(directory, 'gate-enabled.json', { status: 'passed', gateState: 'active' });
  write(directory, 'drain-approved.json', { approved: true, drainSeconds: 331 });
  for (const name of ['reservations-before.json', 'reservations-after.json']) {
    write(directory, name, { status: 'passed', mode: 'require-zero', readOnly: true, activeReservationCount: 0, incompletePaidOrderCount: 0, unresolvedPaymentIntentCount: 0 });
  }
  write(directory, 'eb-deployment.json', {
    status: 'passed', releaseSha: SHA, versionLabel: `mosaic-${SHA}`, packageSha256: '2'.repeat(64),
    deploymentAttempted: true, deploymentVerified: true, sourceTree: '3'.repeat(40), packageSource: 'exact-git-tree', applicationVersion: 'created',
  });
  write(directory, 'aws-deployed.json', { status: 'passed', releaseSha: SHA, expectedVersion: `mosaic-${SHA}`, currentVersion: `mosaic-${SHA}` });
  write(directory, 'public-deployed.json', { expectedSha: SHA, observedSha: SHA, legacyPaymentStatus: 503 });
  if (narrowed) write(directory, 'gate-narrowed.json', { status: 'passed', gateState: 'active', operation: 'narrowed' });
  write(directory, 'gate-final.json', { status: 'passed', gateState: 'active' });
  write(directory, 'public-kept-closed.json', { expectedSha: SHA, observedSha: SHA, legacyPaymentStatus: legacyStatus });
  if (disabled) write(directory, 'gate-disabled.json', { status: 'passed', gateState: 'inactive' });
  return directory;
}

test('keep-closed release evidence succeeds only with the gate verified active and the legacy route retired', (t) => {
  const evidence = buildProductionEvidence({ directory: keptClosedRun(t), releaseSha: SHA, jobStatus: 'success', checkoutAfterRelease: 'keep-closed' });
  assert.equal(evidence.status, 'success');
  assert.equal(evidence.checkoutGate, 'ACTIVE_VERIFIED');
  assert.equal(evidence.checkoutAfterRelease, 'keep-closed');
  assert.equal(evidence.gate.normalCheckoutRestored, false);
  assert.equal(evidence.gate.removal, 'kept-closed-by-policy');
  assert.equal(evidence.probes.keptClosed, 'success');

  // The same files read under the open policy are NOT a completed release.
  const asOpen = buildProductionEvidence({ directory: keptClosedRun(t), releaseSha: SHA, jobStatus: 'success', checkoutAfterRelease: 'open' });
  assert.equal(asOpen.status, 'blocked');
});

test('keep-closed release evidence fails closed on a disable, an un-narrowed bootstrap, or a reachable legacy route', (t) => {
  for (const [options, phase] of [
    [{ disabled: true }, 'checkout-gate-kept-closed'],
    [{ narrowed: false }, 'checkout-gate-narrow'],
    [{ legacyStatus: 401 }, 'checkout-gate-kept-closed'],
  ]) {
    const evidence = buildProductionEvidence({ directory: keptClosedRun(t, options), releaseSha: SHA, jobStatus: 'success', checkoutAfterRelease: 'keep-closed' });
    assert.equal(evidence.status, 'blocked', JSON.stringify(options));
    assert.equal(evidence.failingPhase, phase, JSON.stringify(options));
  }
  // A normal release does not narrow, so it does not need the narrow evidence.
  const release = buildProductionEvidence({ directory: keptClosedRun(t, { mode: 'release', narrowed: false }), releaseSha: SHA, jobStatus: 'success', checkoutAfterRelease: 'keep-closed' });
  assert.equal(release.status, 'success');
});

test('evidence CLI validates the checkout policy', () => {
  const base = ['--directory', 'd', '--output', 'o', '--release-sha', SHA, '--job-status', 'success'];
  assert.equal(parseArgs([...base, '--checkout-after-release', 'keep-closed'])['checkout-after-release'], 'keep-closed');
  assert.throws(() => parseArgs([...base, '--checkout-after-release', 'opened']), /keep-closed or open/);
});

// --- review follow-ups: structural refusal before mutation, fail-safe widening --

function countingClient(fixture) {
  const client = gateApi.createFixtureGateClient(fixture);
  let mutations = 0;
  const modifyRule = client.modifyRule.bind(client);
  client.modifyRule = (...args) => { mutations += 1; return modifyRule(...args); };
  return { client, mutations: () => mutations };
}

test('narrow refuses malformed infrastructure before any mutation, in the uniform and the mixed shape', () => {
  const breakers = {
    'missing ownership tag': (fixture) => { fixture.tags.TagDescriptions[1].Tags = []; },
    'duplicate protected rule': (fixture) => {
      fixture.rulesByListener[HTTPS_LISTENER_ARN].Rules.push({
        RuleArn: `${HTTPS_RULE_ARN}-dup`, Priority: '5', IsDefault: false,
        Conditions: gateApi.gateConditions(gateApi.ACTIVE_PATH, 'release'),
        Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '503' } }],
      });
    },
    'load balancer not active': (fixture) => { fixture.loadBalancers.LoadBalancers[0].State.Code = 'provisioning'; },
  };
  for (const [name, breakIt] of Object.entries(breakers)) {
    for (const httpsMode of ['legacy-retirement-bootstrap', 'release']) {
      const fixture = gateFixture(httpsMode, 'legacy-retirement-bootstrap');
      breakIt(fixture);
      const { client, mutations } = countingClient(fixture);
      assert.throws(() => gateApi.narrowGate(client, gateConfig('legacy-retirement-bootstrap')), undefined, `${name} / ${httpsMode}`);
      assert.equal(mutations(), 0, `${name} / ${httpsMode}: no mutation`);
    }
  }
});

test('fail-safe bootstrap enable widens a narrowed or half-narrowed gate back to the dual path', () => {
  for (const [httpsMode, httpMode, expectedOrder] of [
    ['release', 'release', [HTTPS_RULE_ARN, HTTP_RULE_ARN]],
    ['release', 'legacy-retirement-bootstrap', [HTTPS_RULE_ARN]],
  ]) {
    const { client, observations, order } = watchedClient(gateFixture(httpsMode, httpMode));
    const result = gateApi.transitionGate(client, 'active', gateConfig('legacy-retirement-bootstrap'));
    assert.equal(result.operation, 'widened');
    assert.equal(result.gateState, 'active');
    assert.deepEqual(order, expectedOrder);
    assert.ok(observations.every(Boolean), 'initiate stays blocked while widening');
    assert.equal(gateApi.verifyGate(client, 'active', gateConfig('legacy-retirement-bootstrap')).gateState, 'active');
  }
  // A uniform dual-path gate stays idempotent (no mutation).
  const { client, order } = watchedClient(gateFixture('legacy-retirement-bootstrap'));
  assert.equal(gateApi.transitionGate(client, 'active', gateConfig('legacy-retirement-bootstrap')).operation, 'idempotent');
  assert.deepEqual(order, []);
});

test('bootstrap verify and disable never treat a narrowed rule as the dual-path gate', () => {
  const half = gateFixture('release', 'legacy-retirement-bootstrap');
  assert.throws(() => gateApi.verifyGate(gateApi.createFixtureGateClient(half), 'active', gateConfig('legacy-retirement-bootstrap')),
    /not a recognized exact gate state/);
  const { client, mutations } = countingClient(gateFixture('release'));
  assert.throws(() => gateApi.transitionGate(client, 'inactive', gateConfig('legacy-retirement-bootstrap')));
  assert.equal(mutations(), 0);
});

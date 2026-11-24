const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const express = require('express');

const {
  BOOTSTRAP_CONFIRMATION,
  LEGACY_RETIREMENT_BOOTSTRAP,
  resolveProductionRelease,
  parseArgs: parseResolverArgs,
} = require('../../scripts/release/resolve-production-release');
const {
  WEBHOOK_PATHS,
  parseArgs: parsePublicArgs,
  verifyProductionPublicSurfaces,
} = require('../../scripts/release/verify-production-public-surfaces');
const {
  ACTIVE_PATH_REGEX,
  LEGACY_PAYMENT_PATH_REGEX,
  LEGACY_PAYMENT_SLASH_REGEX,
  activePathRegexValues,
} = require('../../scripts/release/manage-checkout-gate');
const { probeTarget, verifyStatuses } = require('../../scripts/release/probe-target-checkout-surface');
const { analyzeCheckoutSurface } = require('../../scripts/release/verify-checkout-surface-contract');
const {
  createGit,
  verifyLegacyRetirementBootstrap,
} = require('../../scripts/release/verify-legacy-retirement-bootstrap');

const repoRoot = path.resolve(__dirname, '../..');
const workflowSource = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/deploy-eb-production.yml'),
  'utf8'
);
const MAIN = 'a'.repeat(40);
const LIVE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);

function bootstrapInput(overrides = {}) {
  return {
    event: 'workflow_dispatch',
    eventSha: MAIN,
    workflowSha: MAIN,
    requestedSha: MAIN,
    mode: LEGACY_RETIREMENT_BOOTSTRAP,
    confirmation: BOOTSTRAP_CONFIRMATION,
    legacyRetirementSha: '',
    legacyReconciliationSha256: DIGEST,
    currentMainSha: MAIN,
    commitExists: () => true,
    isAncestor: () => true,
    ...overrides,
  };
}

test('resolver admits the bootstrap only by dispatch, exact phrase, exact main, unset retirement SHA and a digest', () => {
  const result = resolveProductionRelease(bootstrapInput());
  assert.equal(result.mode, LEGACY_RETIREMENT_BOOTSTRAP);
  assert.equal(result.releaseSha, MAIN);
  assert.equal(result.sourceRequired, true);
  assert.equal(result.normalRelease, false);
  assert.equal(result.breakGlass, false);
  assert.deepEqual(result.legacyRetirementBootstrap, {
    reconciliationSha256: DIGEST,
    retirementShaRecorded: false,
  });

  assert.throws(() => resolveProductionRelease(bootstrapInput({ event: 'push' })), /cannot enter/);
  assert.throws(() => resolveProductionRelease(bootstrapInput({ confirmation: 'BREAK GLASS ROLLBACK EXACT SHA' })), /confirmation phrase/);
  assert.throws(() => resolveProductionRelease(bootstrapInput({ legacyRetirementSha: LIVE })), /disabled/);
  assert.throws(() => resolveProductionRelease(bootstrapInput({ legacyReconciliationSha256: '' })), /RECONCILIATION/);
  assert.throws(() => resolveProductionRelease(bootstrapInput({ legacyReconciliationSha256: 'xyz' })), /RECONCILIATION/);
  assert.throws(() => resolveProductionRelease(bootstrapInput({ requestedSha: LIVE })), /exact current main tip/);

  const release = resolveProductionRelease(bootstrapInput({ event: 'push', mode: 'release', confirmation: '' }));
  assert.equal(release.legacyRetirementBootstrap, null);
  assert.equal(release.normalRelease, true);
  const rollback = resolveProductionRelease(bootstrapInput({
    mode: 'rollback', requestedSha: LIVE, confirmation: 'BREAK GLASS ROLLBACK EXACT SHA',
  }));
  assert.equal(rollback.legacyRetirementBootstrap, null);
  assert.equal(rollback.sourceRequired, false);

  const args = parseResolverArgs([
    '--event', 'workflow_dispatch', '--mode', LEGACY_RETIREMENT_BOOTSTRAP,
    '--legacy-retirement-sha', '', '--output', 'out.json',
  ]);
  assert.equal(args['legacy-retirement-sha'], '');
});

function response(status, json = {}, headers = {}) {
  return { status, headers: new Headers(headers), async json() { return json; } };
}

function publicFetch(observedSha, checkoutStatus, legacyStatus) {
  return async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method || 'GET';
    if (pathname === '/api/orders/initiate') return response(checkoutStatus);
    if (pathname === '/api/payments/create-payment-intent') return response(legacyStatus);
    if (WEBHOOK_PATHS.includes(pathname)) return response(400);
    if (pathname === '/api/users/auth/check') return response(401);
    if (pathname === '/api/featured-products' && method === 'OPTIONS') {
      return response(204, {}, { 'access-control-allow-origin': options.headers.Origin });
    }
    if (pathname === '/api/featured-products') return response(200);
    return response(200, {
      release: {
        commit: observedSha.slice(0, 7),
        environment: 'production',
        deploymentVersion: `mosaic-${observedSha}`,
      },
    });
  };
}

function publicArgs(mode, overrides = {}) {
  return {
    mode,
    releaseMode: LEGACY_RETIREMENT_BOOTSTRAP,
    baseUrl: 'https://api.example.test',
    expectedSha: MAIN,
    legacyRetirementSha: null,
    legacyReconciliationSha256: DIGEST,
    ...overrides,
  };
}

test('bootstrap public proofs require the pre-retirement live route, a gated deploy, and an ungated 404/405', async () => {
  for (const legacyStatus of [401, 503]) {
    const result = await verifyProductionPublicSurfaces({
      ...publicArgs('preflight'),
      fetchImpl: publicFetch(LIVE, 503, legacyStatus),
    });
    assert.equal(result.observedSha, LIVE);
    assert.deepEqual(result.legacyPaymentCutover, {
      retirementSha: null,
      reconciliationSha256: DIGEST,
      bootstrap: true,
      liveLegacyRouteStatus: legacyStatus,
    });
  }
  await assert.rejects(() => verifyProductionPublicSurfaces({
    ...publicArgs('preflight'), fetchImpl: publicFetch(LIVE, 503, 404),
  }), /already retired on live production/);
  await assert.rejects(() => verifyProductionPublicSurfaces({
    ...publicArgs('preflight', { legacyRetirementSha: LIVE }), fetchImpl: publicFetch(LIVE, 503, 503),
  }), /already recorded/);

  await verifyProductionPublicSurfaces({ ...publicArgs('deployed'), fetchImpl: publicFetch(MAIN, 503, 503) });
  await assert.rejects(() => verifyProductionPublicSurfaces({
    ...publicArgs('deployed'), fetchImpl: publicFetch(MAIN, 503, 401),
  }), /expected legacy route HTTP 503/);

  await verifyProductionPublicSurfaces({ ...publicArgs('ungated'), fetchImpl: publicFetch(MAIN, 401, 404) });
  await assert.rejects(() => verifyProductionPublicSurfaces({
    ...publicArgs('ungated'), fetchImpl: publicFetch(MAIN, 401, 401),
  }), /404 or 405/);

  // Normal release preflight is unchanged: a live legacy route still blocks.
  await assert.rejects(() => verifyProductionPublicSurfaces({
    ...publicArgs('preflight', { releaseMode: 'release', legacyRetirementSha: LIVE }),
    fetchImpl: publicFetch(LIVE, 503, 503),
  }), /still reachable/);
});

test('bootstrap CLI parsing is self-disabling and still requires the reviewed digest', () => {
  const base = ['--mode', 'preflight', '--release-mode', LEGACY_RETIREMENT_BOOTSTRAP,
    '--base-url', 'https://api.example.test', '--expected-sha', MAIN, '--output', 'x.json'];
  const parsed = parsePublicArgs([...base, '--legacy-retirement-sha', '', '--legacy-reconciliation-sha256', DIGEST]);
  assert.equal(parsed.legacyRetirementSha, null);
  assert.equal(parsed.legacyReconciliationSha256, DIGEST);
  assert.throws(() => parsePublicArgs([...base, '--legacy-retirement-sha', LIVE, '--legacy-reconciliation-sha256', DIGEST]), /disabled/);
  assert.throws(() => parsePublicArgs([...base, '--legacy-retirement-sha', '', '--legacy-reconciliation-sha256', '']), /reviewed/);
  // Normal release still requires both attestation values.
  assert.throws(() => parsePublicArgs([
    '--mode', 'preflight', '--base-url', 'https://api.example.test', '--expected-sha', MAIN,
    '--output', 'x.json', '--legacy-retirement-sha', '', '--legacy-reconciliation-sha256', DIGEST,
  ]), /legacy-retirement-sha/);
});

test('bootstrap uses the dual-path ALB gate; release and rollback gate modes are unchanged', () => {
  assert.deepEqual(activePathRegexValues(LEGACY_RETIREMENT_BOOTSTRAP),
    [ACTIVE_PATH_REGEX, LEGACY_PAYMENT_PATH_REGEX, LEGACY_PAYMENT_SLASH_REGEX]);
  assert.deepEqual(activePathRegexValues('focused-baseline'),
    activePathRegexValues(LEGACY_RETIREMENT_BOOTSTRAP));
  assert.deepEqual(activePathRegexValues('release'), [ACTIVE_PATH_REGEX]);
  assert.throws(() => activePathRegexValues('rollback'), /Unsupported/);
});

test('bootstrap target route proofs require an exclusive canonical surface', async () => {
  const result = await verifyStatuses(async (routePath) => (
    routePath.toLowerCase().includes('orders') ? 401 : 404
  ), undefined, LEGACY_RETIREMENT_BOOTSTRAP);
  assert.equal(result.status, 'passed');
  assert.ok(Array.isArray(result.retiredLegacy));
  await assert.rejects(() => verifyStatuses(async () => 401, undefined, LEGACY_RETIREMENT_BOOTSTRAP), /retired legacy/);

  const legacyApp = express();
  const orders = express.Router();
  orders.post('/initiate', (_req, res) => res.sendStatus(401));
  const payments = express.Router();
  payments.post('/create-payment-intent', (_req, res) => res.sendStatus(401));
  legacyApp.use('/api/orders', orders);
  legacyApp.use('/api/payments', payments);
  await assert.rejects(() => probeTarget('/unused', {
    releaseMode: LEGACY_RETIREMENT_BOOTSTRAP,
    env: {},
    loadApp: () => legacyApp,
  }), /still mounts/);

  const canonicalApp = "app.use('/api/orders', orderRoutes);";
  const orderRoutesSource = "router.post('/initiate', authenticate, handler);";
  assert.equal(analyzeCheckoutSurface({
    appSource: canonicalApp,
    paymentRoutesSource: '',
    orderRoutesSource,
    runtimeRouteSources: [canonicalApp, orderRoutesSource],
    releaseMode: LEGACY_RETIREMENT_BOOTSTRAP,
  }).status, 'passed');
  const legacySource = "router.post('/create-payment-intent', authenticate, handler);";
  assert.equal(analyzeCheckoutSurface({
    appSource: canonicalApp,
    paymentRoutesSource: legacySource,
    orderRoutesSource,
    runtimeRouteSources: [canonicalApp, orderRoutesSource, legacySource],
    releaseMode: LEGACY_RETIREMENT_BOOTSTRAP,
  }).status, 'blocked');
});

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-bootstrap-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'user.name', 'release-test');
  git('config', 'core.autocrlf', 'false');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  write('routes/orderRoutes.js', "router.post('/initiate', authenticate, initiateOrder);\n");
  write('routes/paymentRoutes.js', "paymentRouter.post('/create-payment-intent', authenticate, handler);\n");
  write('app.js', "app.use('/api/payments', paymentRoutes);\napp.use('/api/orders', orderRoutes);\n");
  write('tests/legacy.test.js', "// '/create-payment-intent' in tests is not runtime\n");
  const legacy = commit('legacy live');
  fs.rmSync(path.join(dir, 'routes/paymentRoutes.js'));
  write('app.js', "app.use('/api/orders', orderRoutes);\n");
  const retired = commit('retire legacy');
  write('docs/note.md', 'later\n');
  const later = commit('later');
  return { dir, legacy, retired, later };
}

test('bootstrap binding proves forward ancestry, a live legacy tree, and an exclusive target tree', () => {
  const { dir, legacy, retired, later } = gitRepo();
  try {
    const git = createGit(dir);
    const ok = verifyLegacyRetirementBootstrap({
      git, observedSha: legacy, releaseSha: retired,
      legacyRetirementSha: '', legacyReconciliationSha256: DIGEST,
    });
    assert.equal(ok.status, 'passed');
    assert.equal(ok.liveTreeExposesLegacyRoute, true);
    assert.equal(ok.targetTreeExclusiveCanonical, true);
    assert.match(ok.nextAction, new RegExp(`LEGACY_PAYMENT_RETIREMENT_SHA=${retired}`));

    const call = (overrides) => () => verifyLegacyRetirementBootstrap({
      git, observedSha: legacy, releaseSha: retired,
      legacyRetirementSha: '', legacyReconciliationSha256: DIGEST, ...overrides,
    });
    assert.throws(call({ legacyRetirementSha: retired }), /disabled/);
    assert.throws(call({ legacyReconciliationSha256: '' }), /RECONCILIATION/);
    assert.throws(call({ observedSha: retired }), /already live/);
    // Optional EB VersionLabel cross-check (approval job, before mutation).
    const withLabel = call({ ebVersionLabel: `mosaic-${legacy}` })();
    assert.equal(withLabel.ebVersionLabel, `mosaic-${legacy}`);
    assert.equal(withLabel.liveShaMatchesEbVersionLabel, true);
    assert.equal(ok.ebVersionLabel, undefined, 'label fields only appear when cross-checked');
    assert.throws(call({ ebVersionLabel: `mosaic-${retired}` }), /does not match EB VersionLabel/);
    assert.throws(call({ ebVersionLabel: '' }), /does not match EB VersionLabel \(missing\)/);
    assert.throws(call({ ebVersionLabel: legacy }), /does not match EB VersionLabel/);
    assert.throws(call({ ebVersionLabel: `mosaic-${legacy.toUpperCase()}` }), /does not match EB VersionLabel/);
    assert.throws(call({ observedSha: retired, releaseSha: later }), /no longer exposes/);
    assert.throws(call({ observedSha: retired, releaseSha: legacy }), /not an ancestor/);
    assert.throws(call({ observedSha: legacy, releaseSha: legacy }), /already live/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconciliation digest must be lowercase at resolver, preflight and binding (no late failure)', () => {
  const upper = DIGEST.toUpperCase();
  const mixed = `${'C'.repeat(32)}${'c'.repeat(32)}`;
  for (const digest of [upper, mixed]) {
    assert.throws(() => resolveProductionRelease(bootstrapInput({ legacyReconciliationSha256: digest })), /lowercase hex/);
    const base = ['--mode', 'preflight', '--base-url', 'https://api.example.test', '--expected-sha', MAIN, '--output', 'x.json'];
    assert.throws(() => parsePublicArgs([...base, '--release-mode', LEGACY_RETIREMENT_BOOTSTRAP,
      '--legacy-retirement-sha', '', '--legacy-reconciliation-sha256', digest]), /lowercase hex/);
    // Normal release preflight applies the same rule.
    assert.throws(() => parsePublicArgs([...base, '--legacy-retirement-sha', LIVE,
      '--legacy-reconciliation-sha256', digest]), /lowercase hex/);
    assert.throws(() => verifyLegacyRetirementBootstrap({
      git: { isAncestor: () => true, text: () => '' },
      observedSha: LIVE, releaseSha: MAIN, legacyRetirementSha: '', legacyReconciliationSha256: digest,
    }), /lowercase hex/);
  }
  // Lowercase values pass through unchanged (no silent case folding anywhere).
  assert.equal(resolveProductionRelease(bootstrapInput()).legacyRetirementBootstrap.reconciliationSha256, DIGEST);
  const parsed = parsePublicArgs(['--mode', 'preflight', '--base-url', 'https://api.example.test',
    '--expected-sha', MAIN, '--output', 'x.json', '--legacy-retirement-sha', LIVE, '--legacy-reconciliation-sha256', DIGEST]);
  assert.equal(parsed.legacyReconciliationSha256, DIGEST);
  // The approval-job re-check uses the same lowercase-only pattern.
  assert.match(workflowSource, /\[\[ ! "\$LEGACY_PAYMENT_RECONCILIATION_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
});

test('public-surface usage strings list every supported release mode', () => {
  for (const argv of [
    ['--mode'],
    ['--mode', 'bogus', '--base-url', 'https://api.example.test', '--expected-sha', MAIN, '--output', 'x.json'],
  ]) {
    assert.throws(() => parsePublicArgs(argv), (error) => {
      assert.match(error.message, /--release-mode release\|rollback\|focused-baseline\|legacy-retirement-bootstrap/);
      return true;
    });
  }
});

test('approval job cross-checks the bootstrap live SHA against the EB VersionLabel before mutation', () => {
  const approvalJob = workflowSource.slice(workflowSource.indexOf('  production-approval-and-release:'), workflowSource.indexOf('  release-summary:'));
  const revalidate = approvalJob.indexOf('- name: Revalidate topology before mutation');
  const download = approvalJob.indexOf('- name: Download bootstrap public preflight');
  const crossCheck = approvalJob.indexOf('- name: Cross-check bootstrap live SHA against EB VersionLabel');
  const gate = approvalJob.indexOf('- name: Enable exact checkout gate');
  assert.ok(revalidate > 0 && revalidate < download && download < crossCheck && crossCheck < gate);
  const step = approvalJob.slice(crossCheck, gate);
  assert.match(step, /if: env\.RELEASE_MODE == 'legacy-retirement-bootstrap'/);
  assert.match(step, /aws-approved-preflight\.json[\s\S]*currentVersion/);
  assert.match(step, /--eb-version-label "\$eb_version"/);
  assert.match(approvalJob.slice(download, crossCheck), /if: env\.RELEASE_MODE == 'legacy-retirement-bootstrap'[\s\S]*name: production-public-preflight-\$\{\{ needs\.resolve-release\.outputs\.release_sha \}\}/);
});

test('workflow wires the bootstrap behind the same approval without weakening release or rollback', () => {
  assert.match(workflowSource, /- legacy-retirement-bootstrap\n/);
  assert.match(workflowSource, /--legacy-retirement-sha "\$LEGACY_PAYMENT_RETIREMENT_SHA" \\\n\s+--legacy-reconciliation-sha256 "\$LEGACY_PAYMENT_RECONCILIATION_SHA256" \\\n\s+--output release-evidence\/release-identity\.json/);
  // Normal/rollback binding to the recorded retirement SHA remains intact.
  assert.match(workflowSource, /if: needs\.resolve-release\.outputs\.release_mode != 'focused-baseline' && needs\.resolve-release\.outputs\.release_mode != 'legacy-retirement-bootstrap'\n/);
  assert.match(workflowSource, /git -C release-control merge-base --is-ancestor "\$LEGACY_PAYMENT_RETIREMENT_SHA" "\$observed_sha"/);
  assert.match(workflowSource, /git -C release-control merge-base --is-ancestor "\$LEGACY_PAYMENT_RETIREMENT_SHA" "\$RELEASE_SHA"/);
  // Bootstrap binding and source certificate.
  assert.match(workflowSource, /if: needs\.resolve-release\.outputs\.release_mode == 'legacy-retirement-bootstrap'\n[\s\S]*?verify-legacy-retirement-bootstrap\.js/);
  assert.match(workflowSource, /release_mode == 'release' \|\| needs\.resolve-release\.outputs\.release_mode == 'legacy-retirement-bootstrap'\n\s+env:\n\s+GITHUB_TOKEN[\s\S]*?verify-main-release-source\.js/);
  // The only mutating job still requires the protected environment.
  const approvalJob = workflowSource.slice(workflowSource.indexOf('  production-approval-and-release:'), workflowSource.indexOf('  release-summary:'));
  assert.match(approvalJob, /environment:\n(?:\s+#.*\n)*\s+name: production-release-control\n/);
  assert.match(approvalJob, /LEGACY_PAYMENT_RETIREMENT_SHA: \$\{\{ vars\.LEGACY_PAYMENT_RETIREMENT_SHA \}\}/);
  assert.match(approvalJob, /elif \[ "\$RELEASE_MODE" = "legacy-retirement-bootstrap" \]; then\n(?:\s+#.*\n)*\s+test "\$current_main" = "\$RELEASE_SHA"/);
  assert.match(approvalJob, /the one-time bootstrap is disabled/);
  // Rollback reachability check is untouched.
  assert.match(approvalJob, /if \[ "\$RELEASE_MODE" = "rollback" \] && ! git merge-base --is-ancestor "\$RELEASE_SHA" "\$current_main"; then/);
  // Readiness never lets the bootstrap skip the source certificate.
  assert.match(workflowSource, /needs\.resolve-release\.outputs\.release_mode == 'rollback' && needs\.verify-source\.result == 'skipped'/);
  assert.doesNotMatch(workflowSource, /release_mode == 'legacy-retirement-bootstrap' && needs\.verify-source\.result == 'skipped'/);
});

function bashAvailable() {
  if (process.platform === 'win32') return false;
  return spawnSync('bash', ['-c', 'true']).status === 0;
}

function runGateVerifier({ state, orderStatus, legacyStatus }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-bootstrap-gate-'));
  const mockCurl = path.join(dir, 'curl.sh');
  fs.writeFileSync(mockCurl, [
    '#!/usr/bin/env bash',
    'url="${!#}"',
    'case "$url" in',
    '  */api/orders/initiate|*/api/orders/initiate/|*/API/ORDERS/INITIATE|*/Api/Orders/Initiate/) printf "%s" "$MOCK_ORDER_STATUS" ;;',
    '  */api/payments/create-payment-intent|*/api/payments/create-payment-intent/|*/API/PAYMENTS/CREATE-PAYMENT-INTENT|*/Api/Payments/Create-Payment-Intent/) printf "%s" "$MOCK_LEGACY_STATUS" ;;',
    '  */api/health|*/api/ready|*/api/build-info) printf "200" ;;',
    '  *) printf "400" ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(mockCurl, 0o755);
  try {
    const env = { ...process.env, CURL_BIN: mockCurl, MOCK_ORDER_STATUS: String(orderStatus), MOCK_LEGACY_STATUS: String(legacyStatus), RELEASE_MODE: LEGACY_RETIREMENT_BOOTSTRAP };
    const args = [path.join(repoRoot, 'scripts/release/verify-checkout-gate.sh')];
    if (state) args.push('--state', state);
    args.push('http://release-control.test', 'https://release-control.test');
    return spawnSync('bash', args, { encoding: 'utf8', env, timeout: 15000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('gate verifier checks legacy paths in bootstrap mode (gated 503, ungated 404/405)', { skip: !bashAvailable() && 'bash with POSIX paths unavailable' }, () => {
  const active = runGateVerifier({ orderStatus: 503, legacyStatus: 503 });
  assert.equal(active.status, 0, active.stderr);
  assert.equal(active.stdout.split('POST /api/payments/create-payment-intent: HTTP 503').length - 1, 2);
  const leaking = runGateVerifier({ orderStatus: 503, legacyStatus: 401 });
  assert.equal(leaking.status, 1);
  assert.match(leaking.stderr, /legacy payment-intent path during retirement bootstrap/);

  const retired = runGateVerifier({ state: 'inactive', orderStatus: 401, legacyStatus: 404 });
  assert.equal(retired.status, 0, retired.stderr);
  const stillLive = runGateVerifier({ state: 'inactive', orderStatus: 401, legacyStatus: 401 });
  assert.equal(stillLive.status, 1);
  assert.match(stillLive.stderr, /expected retired HTTP 404 or 405/);
});

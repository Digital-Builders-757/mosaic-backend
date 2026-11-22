'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/deploy-eb-production.yml');
const gateScriptPath = path.join(repoRoot, 'scripts/release/verify-checkout-gate.sh');
const instanceScriptPath = path.join(repoRoot, 'scripts/release/verify-eb-instance-versions.sh');
const reservationScriptPath = path.join(repoRoot, 'scripts/release/query-active-reservations.js');
const appPath = path.join(repoRoot, 'app.js');

function toBashPath(filePath) {
  return process.platform === 'win32'
    ? `/mnt/${filePath[0].toLowerCase()}${filePath.slice(2).replaceAll('\\', '/')}`
    : filePath;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const gateBashPath = toBashPath(gateScriptPath);
const instanceBashPath = toBashPath(instanceScriptPath);

const workflow = fs.readFileSync(workflowPath, 'utf8');
const gateScript = fs.readFileSync(gateScriptPath, 'utf8');
const instanceScript = fs.readFileSync(instanceScriptPath, 'utf8');
const reservationScript = fs.readFileSync(reservationScriptPath, 'utf8');

const {
  verifyInstanceDeployments,
} = require('../../scripts/release/verify-eb-instance-deployments');
const {
  ACTIVE_RESERVATION_FILTER,
  parseMode,
  queryActiveReservations,
  run: runReservationDiagnostic,
} = require('../../scripts/release/query-active-reservations');
const {
  APPROVED_BASELINE_SHA,
  BASELINE_OBJECTS,
  PINNED_ROUTE_FILES,
  analyzeCheckoutSurface,
  focusedRouteExemptions,
  main: checkoutSurfaceMain,
  verifyFocusedBaselineProvenance,
} = require('../../scripts/release/verify-checkout-surface-contract');
const { FOCUSED_RELEASE_PROFILES } = require('../../scripts/release/verify-focused-release-source');
const {
  hasCanonicalPostRoute,
  hasLegacyPostRoute,
  verifyStatuses: verifyTargetCheckoutStatuses,
} = require('../../scripts/release/probe-target-checkout-surface');
const {
  CORS_ORIGINS,
  WEBHOOK_PATHS,
  parseArgs: parsePublicArgs,
  verifyProductionPublicSurfaces,
} = require('../../scripts/release/verify-production-public-surfaces');

const webhookPaths = [
  '/api/webhooks/stripe',
  '/api/stripe/webhook',
  '/api/stripe/payment/webhook',
  '/api/subscription/webhook',
  '/api/vendor-onboarding/webhook/payment',
];
const healthPaths = ['/api/health', '/api/ready', '/api/build-info'];

function deployment(instanceId, sha, status = 'Deployed', deploymentId = 42) {
  return {
    InstanceId: instanceId,
    Deployment: {
      VersionLabel: `mosaic-${sha}`,
      DeploymentId: deploymentId,
      Status: status,
    },
  };
}

async function runGateWithStatuses(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(repoRoot, '.release-control-curl-test-'));
  const mockCurl = path.join(tempDir, 'mock-curl.sh');
  fs.writeFileSync(mockCurl, `#!/usr/bin/env bash
url="\${!#}"
case "$url" in
  */api/orders/initiate|*/api/orders/initiate/|*/API/ORDERS/INITIATE|*/Api/Orders/Initiate/) printf '%s' "\${MOCK_INITIATE_STATUS:-503}" ;;
  */api/webhooks/stripe) printf '%s' "\${MOCK_ORDER_WEBHOOK_STATUS:-400}" ;;
  */api/stripe/webhook) printf '%s' "\${MOCK_BUSINESS_WEBHOOK_STATUS:-400}" ;;
  */api/stripe/payment/webhook) printf '%s' "\${MOCK_PAYMENT_WEBHOOK_STATUS:-400}" ;;
  */api/subscription/webhook) printf '%s' "\${MOCK_SUBSCRIPTION_WEBHOOK_STATUS:-400}" ;;
  */api/vendor-onboarding/webhook/payment) printf '%s' "\${MOCK_VENDOR_WEBHOOK_STATUS:-400}" ;;
  */api/health|*/api/ready|*/api/build-info) printf '%s' "\${MOCK_HEALTH_STATUS:-200}" ;;
  *) printf '404' ;;
esac
`);
  fs.chmodSync(mockCurl, 0o755);

  const statusEnvironment = {
    'POST /api/orders/initiate': 'MOCK_INITIATE_STATUS',
    'POST /api/webhooks/stripe': 'MOCK_ORDER_WEBHOOK_STATUS',
    'POST /api/stripe/webhook': 'MOCK_BUSINESS_WEBHOOK_STATUS',
    'POST /api/stripe/payment/webhook': 'MOCK_PAYMENT_WEBHOOK_STATUS',
    'POST /api/subscription/webhook': 'MOCK_SUBSCRIPTION_WEBHOOK_STATUS',
    'POST /api/vendor-onboarding/webhook/payment': 'MOCK_VENDOR_WEBHOOK_STATUS',
  };
  const overrideEnvironment = {};
  for (const [request, status] of Object.entries(overrides)) {
    const envName = statusEnvironment[request];
    if (!envName) throw new Error(`Unsupported mocked request: ${request}`);
    overrideEnvironment[envName] = String(status);
  }

  try {
    const assignments = {
      CURL_BIN: toBashPath(mockCurl),
      RELEASE_HTTP_TIMEOUT_SECONDS: '3',
      ...overrideEnvironment,
    };
    const command = [
      ...Object.entries(assignments).map(([name, value]) => `${name}=${shellQuote(value)}`),
      'bash',
      shellQuote(gateBashPath),
      shellQuote('https://release-control.test'),
    ].join(' ');

    return await execFileAsync('bash', ['-lc', command], {
      cwd: repoRoot,
      timeout: 15000,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('push to main runs preflight and production mutation remains behind Environment approval', () => {
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /environment:\s*\n\s+name: production-preflight/);
  assert.match(workflow, /environment:\s*\n(?:\s+#.*\n)*\s+name: production-release-control/);
  assert.match(workflow, /AWS_RELEASE_CONTROL_ROLE_TO_ASSUME/);
  assert.doesNotMatch(workflow, /vars\.AWS_ROLE_TO_ASSUME/);
  assert.match(workflow, /READY FOR PRODUCTION APPROVAL/);
});

test('normal deployment requires exact current main and rollback is explicit break glass', () => {
  assert.match(workflow, /release_sha:\s*\n\s+description:[^\n]+\n\s+required: true/);
  assert.match(workflow, /resolve-production-release\.js/);
  assert.match(workflow, /BREAK GLASS ROLLBACK EXACT SHA/);
  assert.match(workflow, /current_main=\$\(git rev-parse origin\/main\)/);
  assert.match(workflow, /\$current_main" != "\$RELEASE_SHA/);
  assert.match(workflow, /ref: \$\{\{ needs\.resolve-release\.outputs\.release_sha \}\}/);
  assert.match(workflow, /deploy-eb-exact-sha\.sh/);
});

test('checkout gate verification is ordered before every EB deployment mutation', () => {
  const gateIndex = workflow.indexOf('- name: Enable exact checkout gate');
  const deployIndex = workflow.indexOf('- name: Deploy immutable exact SHA to Elastic Beanstalk');

  assert.ok(gateIndex > 0);
  assert.ok(gateIndex < deployIndex);
  assert.equal((workflow.match(/beanstalk-deploy@/g) || []).length, 0);
  assert.match(workflow, /Require zero release blockers before deploy/);
});

test('gate verifier accepts initiate 503, invalid-signature webhook 400, and healthy surfaces', async () => {
  const result = await runGateWithStatuses();
  assert.match(result.stdout, /Checkout gate is active/);
  for (const pathName of webhookPaths) {
    assert.match(result.stdout, new RegExp(pathName.replaceAll('/', '\\/')));
  }
});

test('gate verifier rejects normal application checkout responses', async (t) => {
  for (const status of [401, 403, 201]) {
    await t.test(`HTTP ${status}`, async () => {
      await assert.rejects(
        runGateWithStatuses({ 'POST /api/orders/initiate': status }),
        (error) => error.code === 1 && /expected infrastructure maintenance HTTP 503/.test(error.stderr)
      );
    });
  }
});

test('gate verifier rejects a webhook blocked by the checkout maintenance rule', async () => {
  await assert.rejects(
    runGateWithStatuses({ 'POST /api/webhooks/stripe': 503 }),
    (error) => error.code === 1 && /maintenance gate also blocks/.test(error.stderr)
  );
});

test('gate verifier rejects a webhook response that is not application signature validation', async () => {
  await assert.rejects(
    runGateWithStatuses({ 'POST /api/stripe/webhook': 404 }),
    (error) => error.code === 1 && /expected application signature rejection HTTP 400/.test(error.stderr)
  );
});

test('gate verifier prints status-only diagnostics and contains no secret-bearing inputs', () => {
  assert.doesNotMatch(gateScript, /Authorization|Cookie|STRIPE_.*SECRET|whsec_|sk_live_|sk_test_/i);
  assert.match(gateScript, /--output \/dev\/null/);
});

test('per-instance verifier accepts only matching completed deployments', () => {
  const sha = 'a'.repeat(40);
  const rows = verifyInstanceDeployments(
    { InstanceHealthList: [deployment('i-00000000aaaabbbb', sha), deployment('i-11111111ccccdddd', sha, 'Deployed', 43)] },
    `mosaic-${sha}`
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.instanceSuffix), ['aaaabbbb', 'ccccdddd']);
});

test('per-instance verifier rejects a stale version', () => {
  const expectedSha = 'a'.repeat(40);
  const staleSha = 'b'.repeat(40);
  assert.throws(
    () => verifyInstanceDeployments({ InstanceHealthList: [deployment('i-stale0001', staleSha)] }, `mosaic-${expectedSha}`),
    /version mismatch/
  );
});

test('per-instance verifier rejects zero instances and unavailable enhanced-health data', () => {
  const expected = `mosaic-${'a'.repeat(40)}`;
  assert.throws(() => verifyInstanceDeployments({ InstanceHealthList: [] }, expected), /zero instances/);
  assert.throws(() => verifyInstanceDeployments({}, expected), /InstanceHealthList is unavailable/);
});

test('per-instance verifier rejects missing Deployment data', () => {
  const expected = `mosaic-${'a'.repeat(40)}`;
  assert.throws(
    () => verifyInstanceDeployments({ InstanceHealthList: [{ InstanceId: 'i-nodeploy' }] }, expected),
    /missing Deployment data/
  );
});

test('per-instance verifier rejects in-progress and failed deployments', async (t) => {
  const sha = 'a'.repeat(40);
  for (const status of ['In Progress', 'Failed']) {
    await t.test(status, () => {
      assert.throws(
        () => verifyInstanceDeployments({ InstanceHealthList: [deployment('i-incomplete', sha, status)] }, `mosaic-${sha}`),
        /deployment is not complete/
      );
    });
  }
});

test('EB wrapper uses current Deployment attribute shape and fails closed on AWS denial', async () => {
  assert.match(instanceScript, /--attribute-names Deployment/);
  assert.doesNotMatch(instanceScript, /--attribute-names DeploymentId VersionLabel/);

  const tempDir = fs.mkdtempSync(path.join(repoRoot, '.release-control-test-'));
  const mockAws = path.join(tempDir, 'mock-aws.sh');
  fs.writeFileSync(mockAws, '#!/usr/bin/env bash\nexit 42\n');
  fs.chmodSync(mockAws, 0o755);

  const bashMockPath = toBashPath(mockAws);

  try {
    const command = [
      `AWS_CLI=${shellQuote(bashMockPath)}`,
      'bash',
      shellQuote(instanceBashPath),
      'a'.repeat(40),
    ].join(' ');
    await assert.rejects(
      execFileAsync('bash', ['-lc', command], {
        cwd: repoRoot,
        timeout: 10000,
      }),
      (error) => error.code === 1 && (
        /Unable to read Elastic Beanstalk per-instance deployment health/.test(error.stderr || error.stdout || '')
        || /pipefail\r/.test(error.stderr || error.stdout || '')
      )
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('active-reservation diagnostic uses the documented read-only query', async () => {
  assert.deepEqual(ACTIVE_RESERVATION_FILTER, {
    inventoryReservedAt: { $ne: null },
    inventoryDecrementedAt: null,
    inventoryRestoredAt: null,
  });

  const calls = [];
  const query = {
    sort(value) {
      calls.push(['sort', value]);
      return this;
    },
    lean() {
      calls.push(['lean']);
      return this;
    },
    async exec() {
      calls.push(['exec']);
      return [];
    },
  };
  const OrderModel = new Proxy({
    find(filter, projection) {
      calls.push(['find', filter, projection]);
      return query;
    },
  }, {
    get(target, property) {
      if (!(property in target)) throw new Error(`Unexpected model operation: ${String(property)}`);
      return target[property];
    },
  });

  const rows = await queryActiveReservations(OrderModel);
  assert.deepEqual(rows, []);
  assert.equal(calls[0][0], 'find');
  assert.deepEqual(calls[0][1], ACTIVE_RESERVATION_FILTER);
  assert.deepEqual(calls.slice(1).map((call) => call[0]), ['sort', 'lean', 'exec']);
  assert.doesNotMatch(reservationScript, /\.(?:update|updateOne|updateMany|delete|deleteOne|deleteMany|insert|insertMany|save|bulkWrite)\s*\(/);
});

test('active-reservation require-zero mode fails on an active reservation and always disconnects', async () => {
  assert.equal(parseMode(['--report']), '--report');
  assert.equal(parseMode(['--require-zero']), '--require-zero');
  assert.throws(() => parseMode([]), /Usage/);

  let disconnected = false;
  const mongoose = {
    async connect() {},
    async disconnect() { disconnected = true; },
  };
  const OrderModel = {
    find() {
      return {
        sort() { return this; },
        lean() { return this; },
        async exec() {
          return [{ _id: 'order-1', inventoryReservedAt: new Date('2026-08-08T00:00:00Z') }];
        },
      };
    },
  };

  await assert.rejects(
    runReservationDiagnostic({
      mode: '--require-zero',
      mongoose,
      OrderModel,
      mongoUri: 'mongodb://read-only.example.invalid/mosaic',
    }),
    /Expected zero active reservations/
  );
  assert.equal(disconnected, true);
});

test('workflow retains status-only public verification and canonical featured-products route', () => {
  assert.match(workflow, /verify-production-public-surfaces\.js/);
  assert.match(workflow, /public-deployed\.json/);
  assert.match(workflow, /public-ungated\.json/);
  const publicVerifier = fs.readFileSync(
    path.join(repoRoot, 'scripts/release/verify-production-public-surfaces.js'),
    'utf8'
  );
  for (const pathName of ['/api/health', '/api/ready', '/api/build-info', '/api/users/auth/check', '/api/featured-products']) {
    assert.match(publicVerifier, new RegExp(pathName.replaceAll('/', '\\/')));
  }
  assert.doesNotMatch(workflow, /\/api\/products\/featured/);
  assert.match(publicVerifier, /CORS_ORIGINS/);
});


test('Stripe raw-body webhook middleware remains mounted before JSON parsing', () => {
  const appSource = fs.readFileSync(appPath, 'utf8');
  const jsonIndex = appSource.indexOf("app.use(express.json({ limit: '1mb' }))");
  assert.ok(jsonIndex > 0);

  for (const marker of [
    "app.use('/api/stripe', stripeRoutes)",
    "app.use('/api/webhooks', webhookRoutes)",
    "app.use('/api/vendor-onboarding/webhook/payment'",
    "app.use('/api/subscription/webhook'",
  ]) {
    const markerIndex = appSource.indexOf(marker);
    assert.ok(markerIndex > 0, `missing raw webhook mount ${marker}`);
    assert.ok(markerIndex < jsonIndex, `${marker} must remain before express.json`);
  }
});

test('focused-baseline source gate requires both approved routes and exact baseline provenance', () => {
  const appSource = "app.use('/api/orders', orderRoutes); app.use('/api/payments', paymentRoutes);";
  const orderRoutesSource = "router.post('/initiate', authenticate, isCustomer, initiateOrder);";
  const paymentRoutesSource = "paymentRouter.post('/create-payment-intent', authenticate, isCustomer, createPaymentIntent);";
  const baselineProvenance = {
    verified: true,
    baselineSha: APPROVED_BASELINE_SHA,
    targetSha: 'a'.repeat(40),
  };
  const inputs = {
    appSource,
    orderRoutesSource,
    paymentRoutesSource,
    runtimeRouteSources: [appSource, orderRoutesSource, paymentRoutesSource],
    releaseMode: 'focused-baseline',
    baselineProvenance,
  };
  const result = analyzeCheckoutSurface(inputs);
  assert.equal(result.status, 'passed');
  assert.equal(result.legacyPaymentSurface, 'active-authenticated-baseline');
  assert.equal(result.legacyRegistrationCount, 1);
  assert.equal(analyzeCheckoutSurface({ ...inputs, baselineProvenance: null }).status, 'blocked');
  assert.equal(analyzeCheckoutSurface({ ...inputs, paymentRoutesSource: '' }).status, 'blocked');
  assert.equal(analyzeCheckoutSurface({
    ...inputs,
    runtimeRouteSources: [...inputs.runtimeRouteSources, "alternate.post('/create-payment-intent', handler);"],
  }).status, 'blocked');
  assert.equal(analyzeCheckoutSurface(inputs).nextAction.includes('retired'), false);
});

function focusedProvenanceFixture() {
  const releaseSha = 'a'.repeat(40);
  const objectIds = new Map([
    ['HEAD^{commit}', releaseSha],
    [`${APPROVED_BASELINE_SHA}^{commit}`, APPROVED_BASELINE_SHA],
  ]);
  for (const name of ['app.js', 'controllers/paymentController.js']) {
    objectIds.set(`HEAD:${name}`, 'b'.repeat(40));
    objectIds.set(`${APPROVED_BASELINE_SHA}:${name}`, 'b'.repeat(40));
  }
  const baselineRoutes = new Map([
    'routes/admin/adminOrderRoutes.js',
    'routes/authRoutes.js',
    'routes/bookingRoutes.js',
    'routes/contactInquiryRoutes.js',
    'routes/orderRoutes.js',
    'routes/paymentRoutes.js',
    'routes/stripeRoutes.js',
    'routes/subscriptionRoutes.js',
    'routes/webhookRoutes.js',
  ].map((file, index) => [file, { mode: '100644', type: 'blob', id: String(index + 1).repeat(40) }]));
  const trees = {
    HEAD: new Map([...baselineRoutes].map(([file, entry]) => [file, { ...entry }])),
    [APPROVED_BASELINE_SHA]: baselineRoutes,
  };
  const calls = [];
  const fakeGit = (_binary, args) => {
    calls.push(args);
    if (args[2] === 'ls-tree') {
      assert.deepEqual(args.slice(3, 6), ['-r', '-z', '--full-tree']);
      assert.deepEqual(args.slice(-2), ['--', 'routes']);
      const tree = trees[args[6]];
      if (!tree) throw new Error('unknown revision');
      return [...tree].map(([file, entry]) => `${entry.mode} ${entry.type} ${entry.id}\t${file}\0`).join('');
    }
    const objectId = objectIds.get(args.at(-1));
    if (!objectId) throw new Error('unknown object');
    return `${objectId}\n`;
  };
  return {
    releaseSha,
    objectIds,
    targetRoutes: trees.HEAD,
    calls,
    options: {
      root: 'target',
      baselineRepo: 'controller',
      releaseSha,
      releaseRef: 'refs/heads/release/focused/contact-recaptcha',
      baselineSha: APPROVED_BASELINE_SHA,
      git: fakeGit,
    },
  };
}

test('focused-baseline provenance pins app, legacy controller, and every route file Git object', () => {
  const { releaseSha, objectIds, targetRoutes, options } = focusedProvenanceFixture();
  const result = verifyFocusedBaselineProvenance(options);
  assert.equal(result.verified, true);
  assert.equal(result.targetSha, releaseSha);
  assert.equal(result.releaseRef, 'refs/heads/release/focused/contact-recaptcha');
  assert.equal(result.profile, 'contact-recaptcha');
  assert.deepEqual(result.comparedObjects, ['app.js', 'controllers/paymentController.js']);
  assert.deepEqual(BASELINE_OBJECTS, ['app.js', 'controllers/paymentController.js']);
  assert.equal(result.routeTree.fileCount, 9);
  assert.equal(result.routeTree.unchangedFiles.length, 9);
  assert.deepEqual(result.routeTree.profileModifiedFiles, []);
  assert.throws(() => verifyFocusedBaselineProvenance({ ...options, baselineSha: 'c'.repeat(40) }), /approved production SHA/);
  assert.throws(() => verifyFocusedBaselineProvenance({ ...options, releaseSha: 'c'.repeat(40) }), /HEAD differs/);
  for (const releaseRef of [undefined, '', 'refs/heads/main', 'refs/heads/release/focused/Contact']) {
    assert.throws(() => verifyFocusedBaselineProvenance({ ...options, releaseRef }), /releaseRef must be/);
  }

  objectIds.set('HEAD:app.js', 'c'.repeat(40));
  assert.throws(() => verifyFocusedBaselineProvenance(options), /changes approved payment route provenance: app\.js/);
  objectIds.set('HEAD:app.js', 'b'.repeat(40));
  objectIds.set('HEAD:controllers/paymentController.js', 'c'.repeat(40));
  assert.throws(() => verifyFocusedBaselineProvenance(options),
    /changes approved payment route provenance: controllers\/paymentController\.js/);
  objectIds.delete('HEAD:controllers/paymentController.js');
  assert.throws(() => verifyFocusedBaselineProvenance(options), /Git provenance is unavailable/);
  objectIds.set('HEAD:controllers/paymentController.js', 'b'.repeat(40));

  targetRoutes.clear();
  assert.throws(() => verifyFocusedBaselineProvenance(options), /Git provenance is unavailable/);
});

test('focused contact profile may change only its listed route file', () => {
  const { targetRoutes, options } = focusedProvenanceFixture();
  targetRoutes.get('routes/contactInquiryRoutes.js').id = 'f'.repeat(40);
  const result = verifyFocusedBaselineProvenance(options);
  assert.equal(result.verified, true);
  assert.deepEqual(result.routeTree.profileModifiedFiles, ['routes/contactInquiryRoutes.js']);
  assert.equal(result.routeTree.unchangedFiles.includes('routes/contactInquiryRoutes.js'), false);
  assert.equal(result.routeTree.unchangedFiles.length, 8);

  // A listed modification must stay a regular blob with the same mode.
  targetRoutes.get('routes/contactInquiryRoutes.js').mode = '100755';
  assert.throws(() => verifyFocusedBaselineProvenance(options), /outside the approved profile: routes\/contactInquiryRoutes\.js/);
  targetRoutes.get('routes/contactInquiryRoutes.js').mode = '120000';
  assert.throws(() => verifyFocusedBaselineProvenance(options), /outside the approved profile: routes\/contactInquiryRoutes\.js/);
  targetRoutes.get('routes/contactInquiryRoutes.js').mode = '100644';

  // The booking profile (selected by every other focused ref) lists no route file.
  assert.throws(() => verifyFocusedBaselineProvenance({
    ...options, releaseRef: 'refs/heads/release/focused/booking-filter',
  }), /outside the approved profile: routes\/contactInquiryRoutes\.js/);
});

test('focused profiles can never change payment-sensitive or unlisted route files', () => {
  const sensitive = [
    'routes/paymentRoutes.js',
    'routes/orderRoutes.js',
    'routes/admin/adminOrderRoutes.js',
    'routes/stripeRoutes.js',
    'routes/subscriptionRoutes.js',
    'routes/webhookRoutes.js',
  ];
  for (const file of sensitive) {
    for (const releaseRef of [
      'refs/heads/release/focused/contact-recaptcha',
      'refs/heads/release/focused/booking-filter',
    ]) {
      const { targetRoutes, options } = focusedProvenanceFixture();
      targetRoutes.get(file).id = 'f'.repeat(40);
      assert.throws(() => verifyFocusedBaselineProvenance({ ...options, releaseRef }),
        new RegExp(`changes approved payment route provenance: ${file.replace(/[./]/g, '\\$&')}`));
    }
  }
  // Mode-only change of a pinned route is still a provenance change.
  {
    const { targetRoutes, options } = focusedProvenanceFixture();
    targetRoutes.get('routes/paymentRoutes.js').mode = '100755';
    assert.throws(() => verifyFocusedBaselineProvenance(options), /payment route provenance: routes\/paymentRoutes\.js/);
  }
  // A modified route file the selected profile does not list.
  {
    const { targetRoutes, options } = focusedProvenanceFixture();
    targetRoutes.get('routes/authRoutes.js').id = 'f'.repeat(40);
    assert.throws(() => verifyFocusedBaselineProvenance(options), /outside the approved profile: routes\/authRoutes\.js/);
  }
  // Added or removed route files, including nested and payment-sensitive ones.
  for (const added of ['routes/newRoutes.js', 'routes/admin/extra.js', 'routes/checkoutRoutes.js']) {
    const { targetRoutes, options } = focusedProvenanceFixture();
    targetRoutes.set(added, { mode: '100644', type: 'blob', id: 'f'.repeat(40) });
    assert.throws(() => verifyFocusedBaselineProvenance(options), new RegExp(`adds route file: ${added.replace(/[./]/g, '\\$&')}`));
  }
  for (const removed of ['routes/contactInquiryRoutes.js', 'routes/paymentRoutes.js', 'routes/authRoutes.js']) {
    const { targetRoutes, options } = focusedProvenanceFixture();
    targetRoutes.delete(removed);
    assert.throws(() => verifyFocusedBaselineProvenance(options), new RegExp(`removes route file: ${removed.replace(/[./]/g, '\\$&')}`));
  }
});

test('focused profile route allowlist rejects payment-sensitive, added, or deleted route entries', () => {
  const profile = (changedFiles) => ({ name: 'hypothetical', changedFiles });
  assert.deepEqual([...focusedRouteExemptions(FOCUSED_RELEASE_PROFILES['contact-recaptcha'])],
    ['routes/contactInquiryRoutes.js']);
  assert.deepEqual([...focusedRouteExemptions(FOCUSED_RELEASE_PROFILES['dashboard-booking-filter'])], []);
  for (const approved of Object.values(FOCUSED_RELEASE_PROFILES)) {
    assert.doesNotThrow(() => focusedRouteExemptions(approved));
  }
  for (const file of [
    ...PINNED_ROUTE_FILES,
    'routes/PaymentRoutes.js',
    'routes/admin/adminOrderRoutes.js',
    'routes/stripe.routes.js',
    'routes/webhookRoutes.js',
    'routes/subscriptionPlanRoutes.js',
    'routes/billing/index.js',
    'routes/invoiceRoutes.js',
    'routes/CHECKOUT.js',
  ]) {
    assert.throws(() => focusedRouteExemptions(profile([['M', file]])), /may not change payment-sensitive route/);
  }
  assert.throws(() => focusedRouteExemptions(profile([['A', 'routes/newRoutes.js']])), /only modify existing route files/);
  assert.throws(() => focusedRouteExemptions(profile([['D', 'routes/authRoutes.js']])), /only modify existing route files/);
  assert.deepEqual([...focusedRouteExemptions(profile([
    ['M', 'controllers/paymentController.js'],
    ['M', 'app.js'],
    ['M', 'routes/authRoutes.js'],
  ]))], ['routes/authRoutes.js']);
});

test('checkout surface CLI requires the protected focused ref and passes it to provenance', () => {
  const runtimeRouteSources = ["app.use('/api/orders', orderRoutes);"];
  const base = [
    '--output', 'unused.json', '--release-mode', 'focused-baseline',
    '--release-sha', 'a'.repeat(40), '--baseline-sha', APPROVED_BASELINE_SHA,
  ];
  assert.throws(() => checkoutSurfaceMain(base, {
    root: 'target', runtimeRouteSources, paymentRoutesSource: '', orderRoutesSource: ' ',
    git: () => { throw new Error('git must not run without a release ref'); },
  }), /--release-ref/);
  const { options } = focusedProvenanceFixture();
  let written;
  assert.throws(() => checkoutSurfaceMain([...base, '--release-ref', options.releaseRef], {
    root: 'target',
    runtimeRouteSources,
    paymentRoutesSource: '',
    orderRoutesSource: ' ',
    git: options.git,
    writeJson: (_file, value) => { written = value; },
  }), /approved dual-route baseline/);
  assert.equal(written.baselineProvenance.verified, true);
  assert.equal(written.baselineProvenance.releaseRef, options.releaseRef);
  assert.equal(written.baselineProvenance.profile, 'contact-recaptcha');
  assert.match(workflow, /RELEASE_REF: \$\{\{ needs\.resolve-release\.outputs\.release_ref \}\}[\s\S]*--release-ref "\$RELEASE_REF"[\s\S]*--baseline-repo release-control/);
});

test('focused-baseline target route proof requires both actual mounted POST routes', async () => {
  const mount = (mountPath, routePath) => ({
    matchers: [(requestPath) => requestPath.startsWith(mountPath)
      ? { path: mountPath, params: {} }
      : false],
    handle: { stack: [{ route: { path: routePath, methods: { post: true } } }] },
  });
  const canonical = mount('/api/orders', '/initiate');
  const legacy = mount('/api/payments', '/create-payment-intent');
  assert.equal(hasCanonicalPostRoute({ router: { stack: [canonical, legacy] } }), true);
  assert.equal(hasLegacyPostRoute({ router: { stack: [canonical, legacy] } }), true);
  assert.equal(hasLegacyPostRoute({ router: { stack: [canonical] } }), false);
  const passed = await verifyTargetCheckoutStatuses(async () => 401, undefined, 'focused-baseline');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.activeLegacy.length, 4);
  assert.equal(Object.hasOwn(passed, 'retiredLegacy'), false);
  await assert.rejects(
    verifyTargetCheckoutStatuses(async (routePath) => routePath.toLowerCase().includes('payments') ? 404 : 401, undefined, 'focused-baseline'),
    /approved legacy payment route/
  );
});

function focusedPublicFetch(observedSha, canonicalStatus, legacyStatus) {
  return async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method || 'GET';
    let status = 200;
    let payload = {};
    if (pathname === '/api/orders/initiate') status = canonicalStatus;
    else if (pathname === '/api/payments/create-payment-intent') status = legacyStatus;
    else if (WEBHOOK_PATHS.includes(pathname)) status = 400;
    else if (pathname === '/api/users/auth/check') status = 401;
    else if (pathname === '/api/featured-products' && method === 'OPTIONS') status = 204;
    else if (['/api/health', '/api/ready', '/api/build-info'].includes(pathname)) {
      payload = { release: {
        commit: observedSha.slice(0, 7),
        deploymentVersion: `mosaic-${observedSha}`,
        environment: 'production',
      } };
    } else if (pathname !== '/api/featured-products') {
      throw new Error(`Unexpected public fixture request: ${method} ${pathname}`);
    }
    return {
      status,
      headers: { get: (name) => name === 'access-control-allow-origin' && CORS_ORIGINS.includes(options.headers?.Origin)
        ? options.headers.Origin : null },
      json: async () => payload,
    };
  };
}

test('focused-baseline public proof distinguishes preflight, gated deployment, and ungated routes', async () => {
  const releaseSha = 'a'.repeat(40);
  const cases = [
    ['preflight', APPROVED_BASELINE_SHA, 503, 503],
    ['deployed', releaseSha, 503, 503],
    ['ungated', releaseSha, 401, 401],
  ];
  for (const [mode, observedSha, canonicalStatus, legacyStatus] of cases) {
    const result = await verifyProductionPublicSurfaces({
      mode,
      releaseMode: 'focused-baseline',
      baseUrl: 'https://api.example.test',
      expectedSha: releaseSha,
      fetchImpl: focusedPublicFetch(observedSha, canonicalStatus, legacyStatus),
    });
    assert.equal(result.observedSha, observedSha);
    assert.equal(result.checkoutStatus, canonicalStatus);
    assert.equal(result.checkoutGateObserved, mode !== 'ungated');
    assert.equal(result.legacyPaymentStatus, legacyStatus);
    assert.equal(result.legacyPaymentSurface, 'active-authenticated-baseline');
    assert.equal(result.legacyPaymentCutover, null);
  }
  await assert.rejects(
    verifyProductionPublicSurfaces({
      mode: 'deployed',
      releaseMode: 'focused-baseline',
      baseUrl: 'https://api.example.test',
      expectedSha: releaseSha,
      fetchImpl: focusedPublicFetch(releaseSha, 503, 401),
    }),
    /expected deployed state/
  );
  await assert.rejects(
    verifyProductionPublicSurfaces({
      mode: 'preflight',
      releaseMode: 'focused-baseline',
      baseUrl: 'https://api.example.test',
      expectedSha: releaseSha,
      fetchImpl: focusedPublicFetch(APPROVED_BASELINE_SHA, 503, 404),
    }),
    /expected preflight state/
  );
  for (const mode of ['preflight', 'deployed']) {
    const observedSha = mode === 'preflight' ? APPROVED_BASELINE_SHA : releaseSha;
    for (const [canonicalStatus, legacyStatus] of [[401, 503], [503, 401]]) {
      await assert.rejects(
        verifyProductionPublicSurfaces({
          mode,
          releaseMode: 'focused-baseline',
          baseUrl: 'https://api.example.test',
          expectedSha: releaseSha,
          fetchImpl: focusedPublicFetch(observedSha, canonicalStatus, legacyStatus),
        }),
        new RegExp(`Focused .*checkout gate is not in expected ${mode} state \\(HTTP 401\\)`)
      );
    }
  }
  for (const [canonicalStatus, legacyStatus] of [[503, 401], [401, 503]]) {
    await assert.rejects(
      verifyProductionPublicSurfaces({
        mode: 'ungated',
        releaseMode: 'focused-baseline',
        baseUrl: 'https://api.example.test',
        expectedSha: releaseSha,
        fetchImpl: focusedPublicFetch(releaseSha, canonicalStatus, legacyStatus),
      }),
      /expected ungated state/
    );
  }
});

test('normal release and rollback public checkout expectations remain unchanged', async () => {
  const releaseSha = 'a'.repeat(40);
  for (const releaseMode of ['release', 'rollback']) {
    for (const [mode, observedSha, canonicalStatus] of [
      ['preflight', APPROVED_BASELINE_SHA, 401],
      ['preflight', APPROVED_BASELINE_SHA, 503],
      ['deployed', releaseSha, 503],
      ['ungated', releaseSha, 401],
    ]) {
      const result = await verifyProductionPublicSurfaces({
        mode,
        releaseMode,
        baseUrl: 'https://api.example.test',
        expectedSha: releaseSha,
        legacyRetirementSha: 'b'.repeat(40),
        legacyReconciliationSha256: 'c'.repeat(64),
        fetchImpl: focusedPublicFetch(observedSha, canonicalStatus, 404),
      });
      assert.equal(result.checkoutStatus, mode === 'deployed' ? null : canonicalStatus);
      assert.equal(result.legacyPaymentStatus, 404);
    }
    await assert.rejects(
      verifyProductionPublicSurfaces({
        mode: 'ungated', releaseMode,
        baseUrl: 'https://api.example.test', expectedSha: releaseSha,
        fetchImpl: focusedPublicFetch(releaseSha, 503, 404),
      }),
      /Checkout is not in normal application state/
    );
    await assert.rejects(
      verifyProductionPublicSurfaces({
        mode: 'deployed', releaseMode,
        baseUrl: 'https://api.example.test', expectedSha: releaseSha,
        fetchImpl: focusedPublicFetch(releaseSha, 503, 503),
      }),
      /Legacy payment-intent route is still reachable/
    );
  }
});

test('focused-baseline CLI does not require retirement attestation; normal preflight still does', () => {
  const baseArgs = ['--mode', 'preflight', '--base-url', 'https://api.example.test', '--expected-sha', 'a'.repeat(40), '--output', 'fixture.json'];
  assert.equal(parsePublicArgs([...baseArgs, '--release-mode', 'focused-baseline']).releaseMode, 'focused-baseline');
  assert.throws(() => parsePublicArgs(baseArgs), /Preflight requires a full legacy-retirement-sha/);
});

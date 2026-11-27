'use strict';

// Regression for production run 46051349218: the approved legacy-retirement
// bootstrap cleared every pre-deploy gate, then deploy-eb-exact-sha.sh rejected
// RELEASE_MODE=legacy-retirement-bootstrap. This exercises the real handoff:
// dispatch inputs -> resolver outputs -> approved-job env -> deploy step ->
// the full deploy script (real Git archive and bundle validation; AWS and the
// two gate verifiers are recorded fakes). Checkout must stay gated throughout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  BOOTSTRAP_CONFIRMATION,
  LEGACY_RETIREMENT_BOOTSTRAP,
  resolveProductionRelease,
} = require('../../scripts/release/resolve-production-release');

const repoRoot = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/deploy-eb-production.yml'), 'utf8'
).replaceAll('\r\n', '\n');
const deployScript = fs.readFileSync(
  path.join(repoRoot, 'scripts/release/deploy-eb-exact-sha.sh'), 'utf8'
).replaceAll('\r\n', '\n');

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function approvedJobEnv() {
  const start = workflow.indexOf('  production-approval-and-release:\n');
  const envStart = workflow.indexOf('\n    env:\n', start);
  const stepsStart = workflow.indexOf('\n    steps:\n', envStart);
  return workflow.slice(envStart, stepsStart);
}

// Map resolver output to the approved job's env exactly as the workflow does
// (GITHUB_OUTPUT keys in resolve-production-release.js main()).
function jobEnvFromResolver(result) {
  return {
    RELEASE_SHA: result.releaseSha,
    RELEASE_MODE: result.mode,
    CHECKOUT_AFTER_RELEASE: 'keep-closed',
    FOCUSED_BASELINE_SHA: result.focusedSource?.baselineSha || '',
    FOCUSED_RELEASE_REF: result.focusedSource?.releaseRef || '',
    FOCUSED_SOURCE_PR: result.focusedSource?.sourcePr || '',
  };
}

test('approved job env is fed by the resolver outputs this test maps', () => {
  const env = approvedJobEnv();
  for (const [key, output] of [
    ['RELEASE_SHA', 'release_sha'],
    ['RELEASE_MODE', 'release_mode'],
    ['CHECKOUT_AFTER_RELEASE', 'checkout_after_release'],
    ['FOCUSED_BASELINE_SHA', 'baseline_sha'],
    ['FOCUSED_RELEASE_REF', 'release_ref'],
    ['FOCUSED_SOURCE_PR', 'source_pr'],
  ]) {
    assert.match(env, new RegExp(`\\n      ${key}: \\$\\{\\{ needs\\.resolve-release\\.outputs\\.${output} \\}\\}\\n`));
  }
});

test('deploy step proves the gate active in the inherited mode before calling the deploy script', () => {
  const deploy = step('Deploy immutable exact SHA to Elastic Beanstalk');
  const gateJs = deploy.indexOf('node scripts/release/manage-checkout-gate.js verify');
  const gateSh = deploy.indexOf('bash scripts/release/verify-checkout-gate.sh');
  const script = deploy.indexOf('bash scripts/release/deploy-eb-exact-sha.sh');
  assert.ok(gateJs !== -1 && gateSh !== -1 && script !== -1);
  assert.ok(gateJs < script && gateSh < script, 'gate proofs must precede the deploy script');
  assert.match(deploy.slice(gateJs, gateSh), /--release-mode "\$RELEASE_MODE"/);
  assert.match(deploy.slice(gateJs, gateSh), /--expected-state active/);
  assert.match(deploy.slice(gateSh, script), /--release-mode "\$RELEASE_MODE"/);
  assert.doesNotMatch(deploy, /disable|--expected-state inactive/);
  // The only gate-disable step stays behind an explicit checkout_after_release=open.
  assert.match(step('Disable exact checkout gate'),
    /if: \$\{\{ [^\n]*needs\.resolve-release\.outputs\.checkout_after_release == 'open'/);
});

test('bootstrap handoff deploys the exact main tip with checkout gated and still rejects unknown modes', (t) => {
  const gitExecutable = process.platform === 'win32'
    ? spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] : null;
  // Git for Windows ships bash beside cmd/ or one level up from mingw32|mingw64/bin.
  const bashCommand = gitExecutable
    ? ['../bin/bash.exe', '../../bin/bash.exe', '../../usr/bin/bash.exe']
      .map((candidate) => path.resolve(path.dirname(gitExecutable), candidate))
      .find((candidate) => fs.existsSync(candidate)) || 'bash'
    : 'bash';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-bootstrap-handoff-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: temporary, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '--quiet');
  runGit('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(temporary, 'app.js'), 'module.exports = "fixture";\n');
  runGit('add', 'app.js');
  runGit('-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
    'commit', '--quiet', '-m', 'fixture');
  const sha = runGit('rev-parse', 'HEAD');
  runGit('update-ref', 'refs/remotes/origin/main', sha);
  fs.mkdirSync(path.join(temporary, 'scripts/release'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts/release/validate-eb-source-bundle.py'),
    path.join(temporary, 'scripts/release/validate-eb-source-bundle.py'));
  fs.writeFileSync(path.join(temporary, 'deploy.sh'), deployScript);

  // Real dispatch inputs for this release, through the real resolver.
  const resolved = resolveProductionRelease({
    event: 'workflow_dispatch',
    eventSha: sha,
    workflowSha: sha,
    requestedSha: sha,
    mode: 'legacy-retirement-bootstrap',
    confirmation: BOOTSTRAP_CONFIRMATION,
    legacyRetirementSha: '',
    legacyReconciliationSha256: 'c'.repeat(64),
    currentMainSha: sha,
    commitExists: () => true,
    isAncestor: () => true,
  });
  assert.equal(resolved.mode, LEGACY_RETIREMENT_BOOTSTRAP);
  assert.equal(resolved.releaseSha, sha);
  const jobEnv = jobEnvFromResolver(resolved);

  fs.writeFileSync(path.join(temporary, 'harness.sh'), `
git() {
  if [ "$1" = fetch ]; then return 0; fi
  command git "$@"
}
python3() { command ${process.platform === 'win32' ? 'python' : 'python3'} "$@"; }
sleep() { :; }
node() {
  case "$1" in
    scripts/release/manage-checkout-gate.js)
      shift
      printf 'GATE-JS %s | env=%s\\n' "$*" "$RELEASE_MODE" >> calls.txt
      [ "$FIXTURE_GATE_ACTIVE" = true ] || return 1
      return 0 ;;
    scripts/release/require-eb-application-version.js)
      shift
      printf 'VERSION-CHECK %s\\n' "$*" >> calls.txt
      return 0 ;;
  esac
  command node "$@"
}
bash() {
  if [ "$1" = scripts/release/verify-checkout-gate.sh ]; then
    shift
    printf 'GATE-SH %s | env=%s\\n' "$*" "$RELEASE_MODE" >> calls.txt
    [ "$FIXTURE_GATE_SH_ACTIVE" = true ] || return 1
    return 0
  fi
  command bash "$@"
}
fake_aws() {
  printf 'AWS %s\\n' "$*" >> calls.txt
  case "$1 $2" in
    's3api get-bucket-location') echo None ;;
    'elasticbeanstalk describe-application-versions')
      if [[ "$*" == *length* ]]; then echo "$FIXTURE_EXISTING";
      else echo "fixture-release-bucket historical-baseline.zip"; fi ;;
    's3api put-object'|'elasticbeanstalk create-application-version'|'elasticbeanstalk update-environment') echo '{}' ;;
    's3api head-object')
      # Echoes the script's own values (it is sourced): the checksum/identity
      # comparisons always pass here and are NOT covered by this test.
      if [[ "$*" == *Metadata* ]]; then printf '%s %s %s\\n' "$package_checksum_b64" "$RELEASE_SHA" "$package_sha";
      else printf '%s\\n' "$package_checksum_b64"; fi ;;
    'elasticbeanstalk describe-environments') printf 'Ready %s Green\\n' "$VERSION_LABEL" ;;
    *) echo "Unexpected mock AWS operation: $1 $2" >&2; return 43 ;;
  esac
}
source ./deploy.sh "$TARGET_SHA" release-evidence/eb-deployment.json
`);

  const invoke = (overrides = {}) => {
    fs.writeFileSync(path.join(temporary, 'calls.txt'), '');
    fs.rmSync(path.join(temporary, 'release-evidence'), { recursive: true, force: true });
    const env = {
      AWS_REGION: 'us-east-1', EB_APPLICATION_NAME: 'fixture', EB_ENVIRONMENT_NAME: 'fixture',
      EB_RELEASE_BUCKET: 'fixture-release-bucket', PRODUCTION_API_URL: 'https://api.example.invalid',
      AWS_CLI: 'fake_aws', FIXTURE_EXISTING: '0', FIXTURE_GATE_ACTIVE: 'true', FIXTURE_GATE_SH_ACTIVE: 'true',
      ...jobEnv, TARGET_SHA: jobEnv.RELEASE_SHA, ...overrides,
    };
    const assignments = Object.entries(env)
      .map(([key, value]) => `${key}='${String(value).replaceAll("'", "'\\''")}'`).join(' ');
    const result = spawnSync(bashCommand, ['-c', `${assignments} bash harness.sh`], {
      cwd: temporary, encoding: 'utf8', timeout: 60000,
    });
    const calls = fs.readFileSync(path.join(temporary, 'calls.txt'), 'utf8');
    const evidencePath = path.join(temporary, 'release-evidence/eb-deployment.json');
    const evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
    return { ...result, calls, lines: calls.split('\n').filter(Boolean), evidence };
  };
  const indexOf = (lines, pattern) => lines.findIndex((line) => pattern.test(line));

  // 1. The exact bootstrap handoff deploys, gated, with release-grade guards.
  const ok = invoke();
  assert.equal(ok.status, 0, ok.stderr);
  const put = indexOf(ok.lines, new RegExp(`^AWS s3api put-object .*--key mosaic-releases/${sha}/[a-f0-9]{64}\\.zip`));
  const create = indexOf(ok.lines, /^AWS elasticbeanstalk create-application-version .* --process /);
  const gateJs = indexOf(ok.lines,
    /^GATE-JS verify --release-mode legacy-retirement-bootstrap --expected-state active .*\| env=legacy-retirement-bootstrap$/);
  const gateSh = indexOf(ok.lines, /^GATE-SH --release-mode legacy-retirement-bootstrap .*\| env=legacy-retirement-bootstrap$/);
  const update = indexOf(ok.lines, new RegExp(`^AWS elasticbeanstalk update-environment .*--version-label mosaic-${sha}`));
  assert.ok(put >= 0 && create > put && gateJs > create && gateSh > gateJs && update > gateSh, ok.calls);
  assert.doesNotMatch(ok.calls, /allow-unprocessed/);
  assert.doesNotMatch(ok.calls, /get-object/);
  assert.doesNotMatch(ok.calls, /elbv2|modify-rule|disable|--expected-state inactive/i,
    'the deploy script never weakens or removes the checkout gate');
  assert.equal(ok.evidence.releaseMode, LEGACY_RETIREMENT_BOOTSTRAP);
  assert.equal(ok.evidence.releaseSha, sha);

  // 2. No gate, no deploy: a gate that is not proven active blocks update-environment.
  //    Each verifier blocks on its own, and it is the gate (not an earlier step) that stops it.
  for (const [override, lastCall] of [
    [{ FIXTURE_GATE_ACTIVE: 'false' }, /^GATE-JS verify --release-mode legacy-retirement-bootstrap --expected-state active /],
    [{ FIXTURE_GATE_SH_ACTIVE: 'false' }, /^GATE-SH --release-mode legacy-retirement-bootstrap /],
  ]) {
    const ungated = invoke(override);
    assert.notEqual(ungated.status, 0);
    assert.match(ungated.lines.at(-1), lastCall, ungated.calls);
    assert.ok(indexOf(ungated.lines, /^AWS elasticbeanstalk create-application-version /) >= 0, ungated.calls);
    assert.doesNotMatch(ungated.calls, /^AWS elasticbeanstalk update-environment/m);
  }

  // 3. A reused version must be this exact deterministic package; bootstrap never
  //    falls into the rollback historical-bundle path.
  const reused = invoke({ FIXTURE_EXISTING: '1' });
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, /does not reference this exact deterministic package/);
  assert.doesNotMatch(reused.calls, /^AWS (s3api get-object|elasticbeanstalk update-environment)/m);

  // 4. The checked-out controller must be the approved target.
  const stale = invoke({ TARGET_SHA: 'f'.repeat(40) });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Checked-out commit does not match the approved release SHA/);
  assert.equal(stale.calls, '');

  // 5. Unknown or near-miss modes are still rejected before any AWS or gate call.
  for (const mode of ['bootstrap', 'legacy-retirement', 'LEGACY-RETIREMENT-BOOTSTRAP', 'focused-rollback-x']) {
    const rejected = invoke({ RELEASE_MODE: mode });
    assert.equal(rejected.status, 2, `${mode}: ${rejected.stderr}`);
    assert.match(rejected.stderr, /RELEASE_MODE must be release, rollback, focused-baseline, or legacy-retirement-bootstrap/);
    assert.equal(rejected.calls, '');
  }
});

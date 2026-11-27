#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FULL_SHA = /^[a-f0-9]{40}$/i;
const ROLLBACK_CONFIRMATION = 'BREAK GLASS ROLLBACK EXACT SHA';
const FOCUSED_BASELINE_SHA = '9bc75c257a9f483a287f122dbd38514b7a4b55d4';
const FOCUSED_REF = /^refs\/heads\/release\/focused\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The reviewed reconciliation digest is compared byte-for-byte downstream
// (approval-job re-check, evidence), so it must be lowercase hex everywhere.
const SHA256 = /^[a-f0-9]{64}$/;
// One-time bootstrap for the first release that retires the legacy
// POST /api/payments/create-payment-intent route. The normal release path
// requires LEGACY_PAYMENT_RETIREMENT_SHA to already be live, which is circular
// for the very first retired SHA. This mode is only admissible while that
// variable is unset, so it disables itself once the retirement is recorded.
const LEGACY_RETIREMENT_BOOTSTRAP = 'legacy-retirement-bootstrap';
const BOOTSTRAP_CONFIRMATION = 'BOOTSTRAP LEGACY PAYMENT RETIREMENT EXACT SHA';
const RELEASE_MODES = Object.freeze(['release', 'rollback', 'focused-baseline', LEGACY_RETIREMENT_BOOTSTRAP]);

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('Invalid release resolver arguments');
    }
    values[argv[index].slice(2)] = argv[index + 1];
  }
  if (!['push', 'workflow_dispatch'].includes(values.event)
      || !RELEASE_MODES.includes(values.mode)
      || !values.output) {
    throw new Error('Release event, mode, and output are required');
  }
  return values;
}

function resolveProductionRelease({
  event,
  eventSha,
  workflowSha,
  requestedSha,
  mode,
  confirmation,
  baselineSha,
  releaseRef,
  sourcePr,
  focusedRefSha,
  legacyRetirementSha,
  legacyReconciliationSha256,
  currentMainSha,
  commitExists,
  isAncestor,
}) {
  if (!FULL_SHA.test(currentMainSha || '')) {
    throw new Error('Current origin/main did not resolve to a full SHA');
  }
  if (!FULL_SHA.test(workflowSha || '') || workflowSha.toLowerCase() !== currentMainSha.toLowerCase()) {
    throw new Error('Executing production workflow definition is not the exact current main revision');
  }

  if (event === 'push' && mode !== 'release') {
    throw new Error('Push-triggered releases cannot enter rollback or focused mode');
  }

  const candidate = (event === 'push' ? eventSha : requestedSha || '').toLowerCase();
  if (!FULL_SHA.test(candidate)) {
    throw new Error('Release candidate must be one full 40-character SHA');
  }
  if (!commitExists(candidate)) {
    throw new Error('Release candidate is not present in this repository');
  }

  let focusedSource = null;
  let legacyRetirementBootstrap = null;
  if (mode === 'release') {
    if (candidate !== currentMainSha.toLowerCase()) {
      throw new Error('Normal production release candidate must equal the exact current main tip');
    }
  } else if (mode === 'rollback') {
    if (event !== 'workflow_dispatch' || confirmation !== ROLLBACK_CONFIRMATION) {
      throw new Error('Break-glass rollback requires the exact confirmation phrase');
    }
    if (!isAncestor(candidate, currentMainSha.toLowerCase())) {
      throw new Error('Rollback candidate must remain reachable from current main');
    }
  } else if (mode === LEGACY_RETIREMENT_BOOTSTRAP) {
    if (event !== 'workflow_dispatch' || confirmation !== BOOTSTRAP_CONFIRMATION) {
      throw new Error('Legacy retirement bootstrap requires manual dispatch and the exact confirmation phrase');
    }
    if (String(legacyRetirementSha || '').trim() !== '') {
      throw new Error('Legacy retirement bootstrap is disabled: LEGACY_PAYMENT_RETIREMENT_SHA is already recorded; use release or rollback');
    }
    if (!SHA256.test(String(legacyReconciliationSha256 || ''))) {
      throw new Error('Legacy retirement bootstrap requires the reviewed LEGACY_PAYMENT_RECONCILIATION_SHA256 as 64 lowercase hex characters');
    }
    if (candidate !== currentMainSha.toLowerCase()) {
      throw new Error('Legacy retirement bootstrap candidate must equal the exact current main tip');
    }
    legacyRetirementBootstrap = {
      reconciliationSha256: String(legacyReconciliationSha256),
      retirementShaRecorded: false,
    };
  } else {
    const normalizedBaseline = String(baselineSha || '').toLowerCase();
    const normalizedRefSha = String(focusedRefSha || '').toLowerCase();
    const parsedPr = Number(sourcePr);
    if (event !== 'workflow_dispatch') {
      throw new Error('Focused release requires manual dispatch');
    }
    if (normalizedBaseline !== FOCUSED_BASELINE_SHA) {
      throw new Error('Focused release baseline does not match the approved production SHA');
    }
    if (!FOCUSED_REF.test(releaseRef || '')) {
      throw new Error('Focused release ref must be a protected release/focused branch');
    }
    if (!Number.isSafeInteger(parsedPr) || parsedPr <= 0 || String(parsedPr) !== String(sourcePr)) {
      throw new Error('Focused release requires one positive merged PR number');
    }
    if (!FULL_SHA.test(normalizedRefSha) || normalizedRefSha !== candidate) {
      throw new Error('Focused release branch tip does not match the exact candidate SHA');
    }
    if (candidate === normalizedBaseline || candidate === currentMainSha.toLowerCase()) {
      throw new Error('Focused release must be a new production-baseline candidate');
    }
    focusedSource = {
      baselineSha: normalizedBaseline,
      releaseRef,
      sourcePr: parsedPr,
    };
  }

  return {
    releaseSha: candidate,
    currentMainSha: currentMainSha.toLowerCase(),
    workflowSha: workflowSha.toLowerCase(),
    mode,
    normalRelease: mode === 'release',
    breakGlass: mode === 'rollback',
    sourceRequired: mode !== 'rollback',
    focusedBaseline: mode === 'focused-baseline',
    focusedSource,
    legacyRetirementBootstrap,
  };
}

function resolveWithGit(args) {
  git(['fetch', '--no-tags', 'origin', 'main']);
  const currentMainSha = git(['rev-parse', 'refs/remotes/origin/main']);
  let focusedRefSha;
  if (args.mode === 'focused-baseline') {
    if (!FOCUSED_REF.test(args['release-ref'] || '')) {
      throw new Error('Focused release ref must be a protected release/focused branch');
    }
    const branch = args['release-ref'].slice('refs/heads/'.length);
    git(['fetch', '--no-tags', 'origin',
      `+${args['release-ref']}:refs/remotes/origin/${branch}`]);
    focusedRefSha = git(['rev-parse', `refs/remotes/origin/${branch}`]);
  }
  return resolveProductionRelease({
    event: args.event,
    eventSha: args['event-sha'],
    workflowSha: args['workflow-sha'],
    requestedSha: args['requested-sha'],
    mode: args.mode,
    confirmation: args.confirmation,
    baselineSha: args['baseline-sha'],
    releaseRef: args['release-ref'],
    sourcePr: args['source-pr'],
    focusedRefSha,
    legacyRetirementSha: args['legacy-retirement-sha'],
    legacyReconciliationSha256: args['legacy-reconciliation-sha256'],
    currentMainSha,
    commitExists(candidate) {
      try {
        git(['cat-file', '-e', `${candidate}^{commit}`]);
        return true;
      } catch (_error) {
        return false;
      }
    },
    isAncestor(candidate, mainSha) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', candidate, mainSha], {
          stdio: 'ignore',
        });
        return true;
      } catch (_error) {
        return false;
      }
    },
  });
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = resolveWithGit(args);
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
      `release_sha=${result.releaseSha}`,
      `current_main_sha=${result.currentMainSha}`,
      `release_mode=${result.mode}`,
      `normal_release=${String(result.normalRelease)}`,
      `source_required=${String(result.sourceRequired)}`,
      `focused_baseline=${String(result.focusedBaseline)}`,
      `baseline_sha=${result.focusedSource?.baselineSha || ''}`,
      `release_ref=${result.focusedSource?.releaseRef || ''}`,
      `source_pr=${result.focusedSource?.sourcePr || ''}`,
      `legacy_retirement_bootstrap=${String(Boolean(result.legacyRetirementBootstrap))}`,
    ].join('\n') + '\n');
  }
  console.log(`Resolved ${result.mode} candidate ${result.releaseSha}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Production release resolution failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BOOTSTRAP_CONFIRMATION,
  FULL_SHA,
  LEGACY_RETIREMENT_BOOTSTRAP,
  RELEASE_MODES,
  ROLLBACK_CONFIRMATION,
  FOCUSED_BASELINE_SHA,
  FOCUSED_REF,
  parseArgs,
  resolveProductionRelease,
  resolveWithGit,
};

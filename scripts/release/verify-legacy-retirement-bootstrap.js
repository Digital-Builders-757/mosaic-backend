#!/usr/bin/env node
'use strict';

// Binds the one-time legacy-retirement bootstrap to Git facts, replacing the
// normal-release requirement that LEGACY_PAYMENT_RETIREMENT_SHA already be an
// ancestor of the live production SHA (impossible for the first retired SHA).
//
// It proves, from trusted current-main Git history only (no network, no AWS):
// - LEGACY_PAYMENT_RETIREMENT_SHA is unset (the bootstrap self-disables once
//   the release owner records the retired SHA);
// - a reviewed reconciliation digest is configured;
// - the live production SHA is an ancestor of the exact target (forward-only);
// - the live production tree still exposes the legacy route (so this really is
//   the first retirement, not a replay after the retirement is already live);
// - the exact target tree exposes only the canonical checkout initiator.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  analyzeCheckoutSurface,
  NON_RUNTIME_DIRECTORIES,
} = require('./verify-checkout-surface-contract');
const {
  nowIso,
  parseOptions,
  requireOption,
  sanitizeMessage,
  writeJson,
} = require('./release-control-utils');

const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_SOURCE = /\.(?:c?js|mjs|tsx?)$/i;

function createGit(repo, run = execFileSync) {
  return {
    text(args) {
      return String(run('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    },
    isAncestor(ancestor, descendant) {
      try {
        run('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], {
          stdio: 'ignore',
          windowsHide: true,
        });
        return true;
      } catch (_error) {
        return false;
      }
    },
  };
}

function isRuntimeSourcePath(file) {
  const segments = file.split('/');
  if (segments.slice(0, -1).some((segment) => NON_RUNTIME_DIRECTORIES.has(segment))) return false;
  return RUNTIME_SOURCE.test(segments[segments.length - 1]);
}

function analyzeTree(git, sha) {
  const files = git.text(['ls-tree', '-r', '--name-only', '-z', sha])
    .split('\0')
    .filter(Boolean);
  const show = (file) => git.text(['show', `${sha}:${file}`]);
  if (!files.includes('app.js')) throw new Error(`Tree ${sha} has no app.js`);
  const runtimeRouteSources = [show('app.js')];
  for (const file of files.sort()) {
    if (file === 'app.js' || !isRuntimeSourcePath(file)) continue;
    runtimeRouteSources.push(show(file));
  }
  return analyzeCheckoutSurface({
    appSource: runtimeRouteSources[0],
    paymentRoutesSource: files.includes('routes/paymentRoutes.js') ? show('routes/paymentRoutes.js') : '',
    orderRoutesSource: files.includes('routes/orderRoutes.js') ? show('routes/orderRoutes.js') : '',
    runtimeRouteSources,
    releaseMode: 'release',
  });
}

function verifyLegacyRetirementBootstrap({
  git,
  observedSha,
  releaseSha,
  legacyRetirementSha,
  legacyReconciliationSha256,
  clock,
}) {
  if (String(legacyRetirementSha || '').trim() !== '') {
    throw new Error('Legacy retirement bootstrap is disabled: LEGACY_PAYMENT_RETIREMENT_SHA is already recorded');
  }
  const digest = String(legacyReconciliationSha256 || '').toLowerCase();
  if (!SHA256.test(digest)) {
    throw new Error('Legacy retirement bootstrap requires LEGACY_PAYMENT_RECONCILIATION_SHA256');
  }
  const live = String(observedSha || '').toLowerCase();
  const target = String(releaseSha || '').toLowerCase();
  if (!FULL_SHA.test(live) || !FULL_SHA.test(target)) {
    throw new Error('Observed and release SHAs must be full SHAs');
  }
  if (live === target) throw new Error('Release target is already live');
  if (!git.isAncestor(live, target)) {
    throw new Error('Live production SHA is not an ancestor of the bootstrap target');
  }
  const liveSurface = analyzeTree(git, live);
  if (liveSurface.legacyPaymentSurfaceActive !== true) {
    throw new Error('Live production tree no longer exposes the legacy route; bootstrap is not applicable');
  }
  const targetSurface = analyzeTree(git, target);
  if (targetSurface.status !== 'passed' || targetSurface.legacyPaymentSurfaceActive !== false) {
    throw new Error('Bootstrap target does not expose an exclusive canonical checkout surface');
  }
  return {
    schemaVersion: 1,
    status: 'passed',
    checkedAt: nowIso(clock),
    releaseMode: 'legacy-retirement-bootstrap',
    observedLiveSha: live,
    releaseSha: target,
    liveIsAncestorOfTarget: true,
    liveTreeExposesLegacyRoute: true,
    targetTreeExclusiveCanonical: true,
    legacyRetirementShaRecorded: false,
    reconciliationSha256: digest,
    productionMutation: false,
    nextAction: 'After a successful bootstrap release, the release owner records '
      + `LEGACY_PAYMENT_RETIREMENT_SHA=${target}; that disables this mode permanently.`,
  };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(argv);
  const repo = path.resolve(requireOption(options, '--repo'));
  const output = requireOption(options, '--output');
  const result = verifyLegacyRetirementBootstrap({
    git: dependencies.git || createGit(repo),
    observedSha: requireOption(options, '--observed-sha'),
    releaseSha: requireOption(options, '--release-sha'),
    legacyRetirementSha: options['--legacy-retirement-sha'] || '',
    legacyReconciliationSha256: options['--legacy-reconciliation-sha256'] || '',
    clock: dependencies.clock,
  });
  (dependencies.writeJson || writeJson)(output, result);
  console.log('Legacy retirement bootstrap binding passed.');
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Legacy retirement bootstrap binding failed: ${sanitizeMessage(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  analyzeTree,
  createGit,
  isRuntimeSourcePath,
  main,
  verifyLegacyRetirementBootstrap,
};

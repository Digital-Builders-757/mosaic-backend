'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BASELINE_SHA,
  SOURCE_SHA,
  REPOSITORY,
  FOCUSED_RELEASE_PROFILES,
  selectProfile,
  parseArgs,
  verifyFocusedReleaseSource,
  verifyLocalProvenance,
} = require('../../scripts/release/verify-focused-release-source');

const releaseSha = 'c'.repeat(40);
const candidateSha = 'd'.repeat(40);
const sourceParentSha = 'e'.repeat(40);
const treeSha = 'f'.repeat(40);
const releaseRef = 'refs/heads/release/focused/booking-9bc75c2';
const releaseBranch = releaseRef.slice('refs/heads/'.length);
const controllerPath = 'controllers/bookingController.js';
const testPath = 'tests/vendor/vendor-booking-type-filter.test.js';
const exactDiff = `M\t${controllerPath}\nA\t${testPath}`;

function ruleset(overrides = {}) {
  return {
    id: 42,
    enforcement: 'active',
    target: 'branch',
    conditions: { ref_name: { include: ['refs/heads/release/focused/*'], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['merge'],
        },
      },
    ],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 456,
    state: 'closed',
    merged: true,
    merged_at: '2026-10-01T20:00:00Z',
    merge_commit_sha: releaseSha,
    base: { ref: releaseBranch, repo: { full_name: REPOSITORY } },
    head: { sha: candidateSha, repo: { full_name: REPOSITORY } },
    user: { login: 'techware-author', type: 'User' },
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    id: 11,
    state: 'APPROVED',
    commit_id: candidateSha,
    submitted_at: '2026-10-01T19:00:00Z',
    user: { login: 'independent-reviewer', type: 'User' },
    ...overrides,
  };
}

function githubFixture(overrides = {}) {
  const responses = {
    [`/repos/${REPOSITORY}/rulesets?includes_parents=true`]: [{ id: 42 }],
    [`/repos/${REPOSITORY}/rulesets/42`]: ruleset(),
    [`/repos/${REPOSITORY}/git/ref/heads/${releaseBranch}`]: {
      ref: releaseRef,
      object: { type: 'commit', sha: releaseSha },
    },
    [`/repos/${REPOSITORY}/pulls/456`]: pullRequest(),
    [`/repos/${REPOSITORY}/pulls/456/reviews?per_page=100&page=1`]: [approval()],
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    request: async (route) => {
      calls.push(route);
      if (!Object.hasOwn(responses, route)) throw new Error(`Unexpected GitHub route ${route}`);
      return responses[route];
    },
  };
}

const contactProfile = FOCUSED_RELEASE_PROFILES['contact-recaptcha'];
const contactRef = 'refs/heads/release/focused/contact-recaptcha';
const contactDiff = contactProfile.changedFiles.map(([status, file]) => `${status}\t${file}`).join('\n');

function gitFixture(overrides = {}, {
  sourceSha = SOURCE_SHA,
  ref = releaseRef,
  diff = exactDiff,
  files = [['M', controllerPath], ['A', testPath]],
} = {}) {
  const responses = new Map();
  const key = (args) => args.join('\0');
  const set = (args, output) => responses.set(key(args), output);
  set(['fetch', '--no-tags', 'origin', BASELINE_SHA, sourceSha, ref], '');
  for (const sha of [BASELINE_SHA, sourceSha, releaseSha, candidateSha]) {
    set(['rev-parse', '--verify', `${sha}^{commit}`], sha);
  }
  set(['rev-list', '--parents', '-n', '1', releaseSha], `${releaseSha} ${BASELINE_SHA} ${candidateSha}`);
  set(['rev-list', '--parents', '-n', '1', candidateSha], `${candidateSha} ${BASELINE_SHA}`);
  set(['rev-list', '--parents', '-n', '1', sourceSha], `${sourceSha} ${sourceParentSha}`);
  set(['log', '-1', '--format=%B', candidateSha], `Booking filter\n\n(cherry picked from commit ${sourceSha})`);
  for (const [before, after] of [
    [BASELINE_SHA, candidateSha],
    [BASELINE_SHA, releaseSha],
    [sourceParentSha, sourceSha],
  ]) {
    set(['diff', '--no-ext-diff', '--no-renames', '--name-status', before, after], diff);
  }
  set(['diff', '--check', BASELINE_SHA, releaseSha], '');
  set(['rev-parse', `${candidateSha}^{tree}`], treeSha);
  set(['rev-parse', `${releaseSha}^{tree}`], treeSha);
  files.forEach(([status, file], index) => {
    for (const sha of [sourceSha, candidateSha, releaseSha]) {
      set(['ls-tree', sha, '--', file], `100644 blob ${String(index + 1).repeat(40)}\t${file}`);
    }
    for (const sha of [sourceParentSha, BASELINE_SHA]) {
      set(['ls-tree', sha, '--', file], status === 'A' ? '' : `100644 blob ${'a'.repeat(39)}${index}\t${file}`);
    }
  });
  for (const [command, value] of Object.entries(overrides)) responses.set(command, value);
  const calls = [];
  return {
    calls,
    key,
    run: (args) => {
      calls.push(args);
      const command = key(args);
      if (!responses.has(command)) throw new Error(`Unexpected git command ${args.join(' ')}`);
      return responses.get(command);
    },
  };
}

async function verify({ github = githubFixture(), git = gitFixture(), ...overrides } = {}) {
  return verifyFocusedReleaseSource({
    repository: REPOSITORY,
    releaseSha,
    baselineSha: BASELINE_SHA,
    releaseRef,
    prNumber: 456,
    githubRequest: github.request,
    runGit: git.run,
    ...overrides,
  });
}

test('CLI accepts only the exact approved baseline, protected ref, and complete inputs', async () => {
  const args = parseArgs([
    '--release-sha', releaseSha,
    '--baseline-sha', BASELINE_SHA,
    '--release-ref', releaseRef,
    '--pr-number', '456',
    '--output', 'certificate.json',
  ]);
  assert.equal(args.prNumber, 456);
  assert.throws(() => parseArgs([
    '--release-sha', releaseSha,
    '--baseline-sha', 'a'.repeat(40),
    '--release-ref', releaseRef,
    '--pr-number', '456',
    '--output', 'certificate.json',
  ]), /approved production SHA/);
  await assert.rejects(verify({ releaseRef: 'refs/heads/release/focused/Nested/branch' }), /releaseRef/);
  await assert.rejects(verify({ repository: 'attacker/mosaic-backend' }), /canonical/);
});

test('certificate binds protected branch, merged PR, current review, exact Git graph and source blobs', async () => {
  const github = githubFixture();
  const git = gitFixture();
  const result = await verify({ github, git });
  assert.equal(result.status, 'passed');
  assert.equal(result.mode, 'focused-baseline');
  assert.equal(result.releaseSha, releaseSha);
  assert.equal(result.branchTipSha, releaseSha);
  assert.equal(result.baselineSha, BASELINE_SHA);
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.sourcePr, 456);
  assert.equal(result.rulesetBypassActorsVisible, true);
  assert.equal(result.pullRequest.approval.reviewer, 'independent-reviewer');
  assert.equal(result.changedFiles.length, 2);
  assert.equal(result.productionAccepted, false);
  assert(git.calls.some((args) => args[0] === 'fetch' && args.includes(releaseRef)));
  assert(github.calls.includes(`/repos/${REPOSITORY}/git/ref/heads/${releaseBranch}`));
});

test('focused branch requires active, approved merge-only rules and rejects visible bypasses', async () => {
  for (const invalid of [
    ruleset({ enforcement: 'disabled' }),
    ruleset({ bypass_actors: [{ actor_id: 1 }] }),
    ruleset({ conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } }),
    ruleset({ rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }] }),
  ]) {
    const github = githubFixture({ [`/repos/${REPOSITORY}/rulesets/42`]: invalid });
    await assert.rejects(verify({ github }), /required active protected PR ruleset/);
  }
});

test('read-only GitHub ruleset responses do not imply no-bypass proof', async () => {
  const withoutVisibleBypasses = ruleset();
  delete withoutVisibleBypasses.bypass_actors;
  const github = githubFixture({
    [`/repos/${REPOSITORY}/rulesets/42`]: withoutVisibleBypasses,
  });
  const result = await verify({ github });
  assert.equal(result.rulesetBypassActorsVisible, false);
  assert.equal(result.productionAccepted, false);
});

test('changed branch tip, fork source, or unmerged PR fails before local Git proof', async () => {
  const wrongTip = githubFixture({
    [`/repos/${REPOSITORY}/git/ref/heads/${releaseBranch}`]: {
      ref: releaseRef,
      object: { type: 'commit', sha: '9'.repeat(40) },
    },
  });
  await assert.rejects(verify({ github: wrongTip }), /branch tip differs/);
  const fork = githubFixture({
    [`/repos/${REPOSITORY}/pulls/456`]: pullRequest({
      head: { sha: candidateSha, repo: { full_name: 'attacker/fork' } },
    }),
  });
  await assert.rejects(verify({ github: fork }), /merged same-repository/);
  const unmerged = githubFixture({
    [`/repos/${REPOSITORY}/pulls/456`]: pullRequest({ merged: false }),
  });
  await assert.rejects(verify({ github: unmerged }), /merged same-repository/);
});

test('branch tip must still be exact after local provenance verification', async () => {
  const github = githubFixture();
  const original = github.request;
  let refReads = 0;
  github.request = async (route) => {
    if (route === `/repos/${REPOSITORY}/git/ref/heads/${releaseBranch}` && ++refReads === 2) {
      return { ref: releaseRef, object: { type: 'commit', sha: '9'.repeat(40) } };
    }
    return original(route);
  };
  await assert.rejects(verify({ github }), /changed during source certification/);
});

test('stale or superseded approvals do not certify a PR', async () => {
  const stale = githubFixture({
    [`/repos/${REPOSITORY}/pulls/456/reviews?per_page=100&page=1`]: [
      approval({ commit_id: '9'.repeat(40) }),
    ],
  });
  await assert.rejects(verify({ github: stale }), /current independent human approval/);
  const withdrawn = githubFixture({
    [`/repos/${REPOSITORY}/pulls/456/reviews?per_page=100&page=1`]: [
      approval(), approval({ id: 12, state: 'CHANGES_REQUESTED' }),
    ],
  });
  await assert.rejects(verify({ github: withdrawn }), /current independent human approval/);
  const selfReview = githubFixture({
    [`/repos/${REPOSITORY}/pulls/456/reviews?per_page=100&page=1`]: [
      approval({ user: { login: 'techware-author', type: 'User' } }),
    ],
  });
  await assert.rejects(verify({ github: selfReview }), /current independent human approval/);
});

test('local provenance rejects an extra path, wrong parent, altered blob, or missing cherry-pick trailer', () => {
  const base = { releaseSha, baselineSha: BASELINE_SHA, releaseRef, candidateSha };
  const cases = [
    [
      ['diff', '--no-ext-diff', '--no-renames', '--name-status', BASELINE_SHA, releaseSha],
      `${exactDiff}\nM\tmodels/Booking.js`,
      /exactly the approved/,
    ],
    [
      ['rev-list', '--parents', '-n', '1', releaseSha],
      `${releaseSha} ${candidateSha} ${BASELINE_SHA}`,
      /two-parent merge/,
    ],
    [
      ['ls-tree', releaseSha, '--', controllerPath],
      `100644 blob ${'9'.repeat(40)}\t${controllerPath}`,
      /blob or mode differs/,
    ],
    [
      ['log', '-1', '--format=%B', candidateSha],
      'Booking filter without provenance',
      /cherry-pick provenance/,
    ],
  ];
  for (const [command, output, expected] of cases) {
    const fixture = gitFixture();
    const altered = gitFixture({ [fixture.key(command)]: output });
    assert.throws(() => verifyLocalProvenance({ ...base, runGit: altered.run }), expected);
  }
});

function contactGitFixture(overrides = {}) {
  return gitFixture(overrides, {
    sourceSha: contactProfile.sourceSha,
    ref: contactRef,
    diff: contactDiff,
    files: contactProfile.changedFiles,
  });
}

test('profile allowlist is frozen and selected only by the protected release ref', () => {
  assert(Object.isFrozen(FOCUSED_RELEASE_PROFILES));
  assert.deepEqual(Object.keys(FOCUSED_RELEASE_PROFILES).sort(), ['contact-recaptcha', 'dashboard-booking-filter']);
  for (const profile of Object.values(FOCUSED_RELEASE_PROFILES)) {
    assert(Object.isFrozen(profile));
    assert(Object.isFrozen(profile.changedFiles));
    assert(profile.changedFiles.every((entry) => Object.isFrozen(entry)));
  }
  assert.equal(FOCUSED_RELEASE_PROFILES['dashboard-booking-filter'].sourceSha, SOURCE_SHA);
  assert.equal(contactProfile.sourceSha, 'd7d0381e3af6091ec0b1f0fd22a43285da574a7e');
  assert.equal(contactProfile.releaseRef, contactRef);
  assert.equal(selectProfile(contactRef).name, 'contact-recaptcha');
  for (const ref of [releaseRef, 'refs/heads/release/focused/dashboard-booking-filter',
    'refs/heads/release/focused/contact-recaptcha-2']) {
    assert.equal(selectProfile(ref).name, 'dashboard-booking-filter');
  }
  assert.throws(() => selectProfile(contactRef, 'unknown-profile'), /Unknown focused release profile/);
  assert.throws(() => selectProfile(contactRef, '__proto__'), /Unknown focused release profile/);
  assert.throws(() => selectProfile(contactRef, 'dashboard-booking-filter'), /does not match the protected release ref/);
  assert.throws(() => selectProfile(releaseRef, 'contact-recaptcha'), /does not match the protected release ref/);
  for (const ref of ['refs/heads/release/focused/Contact-Recaptcha', 'refs/heads/release/contact-recaptcha',
    'refs/heads/release/focused/contact/recaptcha', undefined]) {
    assert.throws(() => selectProfile(ref), /releaseRef/);
  }
});

test('booking profile still certifies its fixture and keeps its exact two-file set', async () => {
  const provenance = verifyLocalProvenance({
    releaseSha, baselineSha: BASELINE_SHA, releaseRef, candidateSha, runGit: gitFixture().run,
  });
  assert.equal(provenance.profile, 'dashboard-booking-filter');
  assert.equal(provenance.sourceSha, SOURCE_SHA);
  assert.deepEqual(provenance.changedFiles, [
    { status: 'M', file: controllerPath },
    { status: 'A', file: testPath },
  ]);
  const result = await verify({ profile: 'dashboard-booking-filter' });
  assert.equal(result.profile, 'dashboard-booking-filter');
  await assert.rejects(verify({ profile: 'contact-recaptcha' }), /does not match the protected release ref/);
});

test('contact-recaptcha profile certifies exactly its four approved files on its own ref', async () => {
  const contactBranch = contactRef.slice('refs/heads/'.length);
  const github = githubFixture({
    [`/repos/${REPOSITORY}/git/ref/heads/${contactBranch}`]: {
      ref: contactRef,
      object: { type: 'commit', sha: releaseSha },
    },
    [`/repos/${REPOSITORY}/pulls/456`]: pullRequest({
      base: { ref: contactBranch, repo: { full_name: REPOSITORY } },
    }),
  });
  const git = contactGitFixture();
  const result = await verify({ github, git, releaseRef: contactRef });
  assert.equal(result.status, 'passed');
  assert.equal(result.profile, 'contact-recaptcha');
  assert.equal(result.sourceSha, contactProfile.sourceSha);
  assert.equal(result.releaseRef, contactRef);
  assert.equal(result.changedFiles.map(({ status, file }) => `${status}\t${file}`).join('\n'), contactDiff);
  assert.deepEqual(Object.keys(result.fileBlobs).sort(), contactProfile.changedFiles.map(([, file]) => file).sort());
  assert(git.calls.some((args) => args[0] === 'fetch' && args.includes(contactProfile.sourceSha)
    && args.includes(contactRef) && !args.includes(SOURCE_SHA)));
  await assert.rejects(verify({ github, git: contactGitFixture(), releaseRef: contactRef, profile: 'nope' }),
    /Unknown focused release profile/);
});

test('contact and booking profiles reject each other\'s file sets and source commits', () => {
  const contactBase = { releaseSha, baselineSha: BASELINE_SHA, releaseRef: contactRef, candidateSha };
  const bookingBase = { releaseSha, baselineSha: BASELINE_SHA, releaseRef, candidateSha };
  // The contact ref with the booking two-file set fails closed.
  const bookingFilesOnContact = gitFixture({}, { sourceSha: contactProfile.sourceSha, ref: contactRef });
  assert.throws(() => verifyLocalProvenance({ ...contactBase, runGit: bookingFilesOnContact.run }),
    /exactly the approved contact inquiry reCAPTCHA/);
  // The contact ref never fetches or accepts the booking source commit.
  assert.throws(() => verifyLocalProvenance({ ...contactBase, runGit: gitFixture().run }), /Unexpected git command fetch/);
  // A booking (non-contact) focused ref with the contact four-file set fails closed.
  const contactFilesOnBooking = gitFixture({}, { diff: contactDiff, files: contactProfile.changedFiles });
  assert.throws(() => verifyLocalProvenance({ ...bookingBase, runGit: contactFilesOnBooking.run }),
    /exactly the approved booking controller and test changes/);
  assert.throws(() => verifyLocalProvenance({ ...bookingBase, runGit: contactGitFixture().run }),
    /Unexpected git command fetch/);
});

test('contact profile rejects an extra or missing file, a wrong trailer, extra parent, or altered blobs', () => {
  const base = { releaseSha, baselineSha: BASELINE_SHA, releaseRef: contactRef, candidateSha };
  const [, controller] = contactProfile.changedFiles[0];
  const cases = [
    [
      ['diff', '--no-ext-diff', '--no-renames', '--name-status', BASELINE_SHA, releaseSha],
      `${contactDiff}\nM\tapp.js`,
      /exactly the approved contact inquiry reCAPTCHA/,
    ],
    [
      ['diff', '--no-ext-diff', '--no-renames', '--name-status', BASELINE_SHA, candidateSha],
      contactDiff.split('\n').slice(0, 3).join('\n'),
      /exactly the approved contact inquiry reCAPTCHA/,
    ],
    [
      ['diff', '--no-ext-diff', '--no-renames', '--name-status', sourceParentSha, contactProfile.sourceSha],
      `${contactDiff}\nM\troutes/index.js`,
      /exactly the approved contact inquiry reCAPTCHA/,
    ],
    [
      ['log', '-1', '--format=%B', candidateSha],
      `Contact reCAPTCHA\n\n(cherry picked from commit ${SOURCE_SHA})`,
      /cherry-pick provenance/,
    ],
    [
      ['log', '-1', '--format=%B', candidateSha],
      `Contact reCAPTCHA\n\n(cherry picked from commit ${'9'.repeat(40)})`,
      /cherry-pick provenance/,
    ],
    [
      ['ls-tree', releaseSha, '--', controller],
      `100644 blob ${'9'.repeat(40)}\t${controller}`,
      /blob or mode differs/,
    ],
    [
      ['ls-tree', BASELINE_SHA, '--', controller],
      `100644 blob ${'8'.repeat(40)}\t${controller}`,
      /differs from the approved source parent/,
    ],
    [
      ['rev-list', '--parents', '-n', '1', candidateSha],
      `${candidateSha} ${BASELINE_SHA} ${sourceParentSha}`,
      /one commit directly on the production baseline/,
    ],
  ];
  for (const [command, output, expected] of cases) {
    const fixture = contactGitFixture();
    const altered = contactGitFixture({ [fixture.key(command)]: output });
    assert.throws(() => verifyLocalProvenance({ ...base, runGit: altered.run }), expected);
  }
  assert.throws(() => verifyLocalProvenance({
    ...base, baselineSha: 'a'.repeat(40), runGit: contactGitFixture().run,
  }), /approved production SHA/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const build = require('../src/build-info');

test('the commit and its link come from what the platform reported', () => {
  const sha = 'd0beb8f5c55b36df7d674d55965a23b8d54ad69b';
  const info = build.describe({
    RAILWAY_GIT_COMMIT_SHA: sha,
    RAILWAY_GIT_BRANCH: 'main',
    RAILWAY_GIT_REPO_OWNER: 'Bihaqo',
    RAILWAY_GIT_REPO_NAME: 'tallyhouse',
  });
  assert.equal(info.commit, sha);
  assert.equal(info.shortCommit, sha.slice(0, 7));
  assert.equal(info.branch, 'main');
  assert.equal(info.commitUrl, `https://github.com/Bihaqo/tallyhouse/commit/${sha}`);
});

test('a fork advertises the fork, which is the point of reading it from the env', () => {
  const info = build.describe({
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    RAILWAY_GIT_REPO_OWNER: 'someone-else',
    RAILWAY_GIT_REPO_NAME: 'their-fork',
  });
  assert.match(info.commitUrl, /^https:\/\/github\.com\/someone-else\/their-fork\/commit\//);
});

test('SOURCE_REPO_URL overrides, and empty means print the commit but link nothing', () => {
  const env = { RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40), RAILWAY_GIT_REPO_OWNER: 'o', RAILWAY_GIT_REPO_NAME: 'n' };
  assert.equal(
    build.describe({ ...env, SOURCE_REPO_URL: 'https://git.example/tally/' }).commitUrl,
    `https://git.example/tally/commit/${'b'.repeat(40)}`,
  );
  const hidden = build.describe({ ...env, SOURCE_REPO_URL: '' });
  assert.equal(hidden.repoUrl, null);
  assert.equal(hidden.commitUrl, null);
  assert.equal(hidden.shortCommit, 'b'.repeat(7), 'the commit is still stated');
});

test('a commit with nowhere to point at is stated without a link', () => {
  const info = build.describe({ RAILWAY_GIT_COMMIT_SHA: 'c'.repeat(40) });
  assert.equal(info.repoUrl, null);
  assert.equal(info.commitUrl, null);
  assert.equal(info.shortCommit, 'c'.repeat(7));
});

test('anything that is not a commit id is reported as no commit at all', () => {
  // A misconfigured variable printed in the footer as if it were a commit is
  // worse than an absent footer: it is a provenance claim nobody can check.
  for (const bad of ['', 'HEAD', 'main', 'not a sha', 'zzzz', 'abc', undefined, null, 7]) {
    const info = build.describe({ RAILWAY_GIT_COMMIT_SHA: bad });
    assert.equal(info.commit, null, String(bad));
    assert.equal(info.commitUrl, null, String(bad));
  }
});

test('the live object is frozen and dated, so /version cannot be edited by a handler', () => {
  assert.ok(Object.isFrozen(build.info));
  assert.match(build.info.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  if (build.info.commit) assert.ok(build.isSha(build.info.commit));
});

'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Which source commit this process is running, for `/version` and the footer.
 *
 * The point is public verifiability: the live instance names the commit it is
 * serving, and anyone can open that commit and read the code that answered
 * their request. The values come from `RAILWAY_GIT_*`, which Railway injects
 * into any deployment it built from a GitHub trigger — so they are the
 * builder's account of what it deployed, not a number committed here that
 * could go stale, and a fork deployed by somebody else advertises *their*
 * repo rather than this one.
 *
 * This is evidence, not proof. A server asserting its own provenance shows
 * which commit it claims, not that the running process was built from that
 * tree and nothing else. What makes the claim worth something is that it is
 * checkable from outside and over time:
 * `.github/workflows/verify-deployment.yml` reads `/version` after every push
 * and once a day, so a deployment that quietly stopped following `main` turns
 * into a failing check on the repo rather than into nothing at all.
 */

// Anything that isn't a git object id is a misconfigured env var, and printing
// it in the footer as if it were a commit would be worse than printing nothing.
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim());

/**
 * Where the source lives, as a browsable repo URL.
 *
 * Deliberately only ever the deploying platform's own answer or an explicit
 * setting — never inferred from anything in the tree. A guessed repo link is
 * worse than no link: a self-hoster's commit id under this project's GitHub
 * URL is a 404 that claims a provenance nobody checked. `SOURCE_REPO_URL`
 * covers sources Railway can't name (a mirror, a private host), and set empty
 * it means "print the commit, link it nowhere".
 */
function repoUrl(env) {
  if (env.SOURCE_REPO_URL !== undefined) return env.SOURCE_REPO_URL.replace(/\/+$/, '') || null;
  if (env.RAILWAY_GIT_REPO_OWNER && env.RAILWAY_GIT_REPO_NAME) {
    return `https://github.com/${env.RAILWAY_GIT_REPO_OWNER}/${env.RAILWAY_GIT_REPO_NAME}`;
  }
  return null;
}

function describe(env) {
  const commit = isSha(env.RAILWAY_GIT_COMMIT_SHA) ? env.RAILWAY_GIT_COMMIT_SHA.trim().toLowerCase() : null;
  const repo = repoUrl(env);
  return {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    branch: env.RAILWAY_GIT_BRANCH || null,
    repoUrl: repo,
    commitUrl: commit && repo ? `${repo}/commit/${commit}` : null,
  };
}

/**
 * The commit of the checkout the process was started from.
 *
 * Only consulted when the platform said nothing, which means local development
 * and self-hosts that run from a working copy. Deployed containers rarely carry
 * a `.git`, so failing here is ordinary: it reports `null` and the footer drops
 * the line rather than getting in the way of a boot.
 */
function localCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Read once: none of it changes while the process lives. `startedAt` is how
// long this deployment has been up, which is the other half of "what is
// running right now" — a commit alone can't distinguish a redeploy that landed
// a minute ago from one that has been serving for a month.
const info = Object.freeze({
  ...(() => {
    const deployed = describe(process.env);
    if (deployed.commit) return deployed;
    const local = localCommit();
    return local ? describe({ ...process.env, RAILWAY_GIT_COMMIT_SHA: local }) : deployed;
  })(),
  startedAt: new Date().toISOString(),
});

module.exports = { info, describe, repoUrl, isSha };

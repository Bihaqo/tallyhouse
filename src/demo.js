'use strict';

/**
 * The signed-out demo: a real account, holding invented data, that lives
 * exactly as long as the cookie that made it.
 *
 * The whole design is "a normal account with one flag set". A demo user gets a
 * row in `users` like anybody else, its own rules document, its own overrides
 * and its own cached transactions, so every feature works through the code that
 * already exists — classifying by hand, editing categories, adding rules,
 * changing the currency, exporting. Nothing is special-cased into a read-only
 * tour, because a tour that cannot be touched does not answer the question a
 * visitor actually has, which is what it is like to use this.
 *
 * What the flag changes is only where the data comes from and what may be
 * spent:
 *
 *   - `src/summary.js` reads the deterministic generator in `src/mock.js`
 *     instead of Lunchflow, so a demo account never has a bank connection and
 *     never needs a key.
 *   - `src/gpt.js` reviews with its mock reviewer, so the AI review is visible
 *     and clickable and no request ever reaches OpenAI. This is the one place
 *     where "it must not cost anything" is load-bearing rather than tidy: the
 *     demo is unauthenticated, so a demo account that could spend would be an
 *     open invitation to spend the operator's money.
 *   - Everything that would make the account permanent or billable is refused
 *     in `server.js` — storing API keys, joining the waiting list, importing an
 *     export.
 *
 * Lifetime is the session, not a timer of its own: `reap()` deletes demo
 * accounts with no unexpired row in `user_sessions`. The cookie is 24 hours and
 * slides on use, so a demo lasts through an afternoon of poking at it and is
 * gone a day after the tab is closed. That inverts the usual cleanup problem —
 * there is no separate expiry to keep in step with the session, and a session
 * that survives a deploy keeps its account with it.
 *
 * Demo accounts are deliberately invisible to the rest of the instance: they do
 * not count against MAX_USERS (see users.js), and the admin panel excludes them
 * from every figure, because a demo is not a signup and counting it as one
 * would make the funnel a measure of curiosity.
 */

const crypto = require('node:crypto');
const db = require('./db');
const users = require('./users');
const rules = require('./rules');

// How long a demo cookie lasts, refreshed on every request that uses it. The
// account is deleted once no live session points at it, so this number is the
// only lifetime there is.
const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many demo accounts may exist at once.
 *
 * Creating one takes no account, no email and no proof of anything, so this is
 * the only thing standing between a script and an unbounded number of rows.
 * The binding resource is the same one that caps real accounts — each account's
 * transaction pull is held in a Map in src/summary.js — and a demo pull is the
 * same size as a real one. Turning demos off entirely is `MAX_DEMO_ACCOUNTS=0`,
 * which is the setting a self-hoster who never wanted a public demo wants.
 */
const DEFAULT_MAX_DEMO = 25;
function maxDemoAccounts() {
  const configured = process.env.MAX_DEMO_ACCOUNTS;
  if (configured === undefined || configured === '') return DEFAULT_MAX_DEMO;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Which accounts are demos, in memory.
 *
 * Read on the hot path — every transaction fetch and every review asks — and
 * the answer decides whether a request may reach a paid third party, so it must
 * not be an await in the middle of `fetchRaw`. The set is loaded at boot and
 * maintained by the two operations that change it (create and reap), which is
 * sound because the sweep state in src/gpt.js already requires a single
 * replica. On a second replica a demo created there would be unknown here — so
 * `isDemo` is written to fail *closed* in the one direction that matters: an
 * unknown id is treated as a real account, which refuses to spend a key it does
 * not have rather than quietly billing somebody.
 */
const demoIds = new Set();

const isDemo = (userId) => userId != null && demoIds.has(Number(userId));

async function load() {
  const { rows } = await db.query('SELECT id FROM users WHERE is_demo');
  demoIds.clear();
  for (const row of rows) demoIds.add(Number(row.id));
  return demoIds.size;
}

const liveCount = () => demoIds.size;
const forget = (userId) => demoIds.delete(Number(userId));

/**
 * The categories a demo account starts with.
 *
 * These are the list `src/gpt.js`'s mock reviewer proposes for this data, with
 * the patterns filled in — which is what a real account reaches after setup and
 * a few minutes of tidying, and therefore what the dashboard is supposed to
 * look like when it is working. An empty category list would show a wall of
 * "Other" and demonstrate nothing.
 *
 * Two merchants in the generated data are deliberately left unmatched (see the
 * note in src/mock.js), so "Other" is not empty either: there is something for
 * the AI review to have an opinion about and something to classify by hand,
 * which are the two things worth trying.
 *
 * There is deliberately no "Salary" category, though the generated data pays
 * two. Income here is any money in that no *excluded* category claims, so a
 * salary category marked excludeFromSpending does not tidy the salaries away —
 * it hides them from the income totals, and the dashboard then reports a year
 * of pure loss.
 */
const DEMO_CATEGORIES = [
  { id: 'internal-transfers', name: 'Internal transfers', excludeFromSpending: true, autoTransfers: true,
    patterns: ['transfer to', 'transfer from', 'top-up'] },
  { id: 'mortgage', name: 'Mortgage', excludeFromSpending: true, tracker: true,
    patterns: ['highstreet mortgage'] },
  { id: 'investments', name: 'Investments', excludeFromSpending: true, tracker: true,
    patterns: ['coinvault', 'northgate securities', 'meridian metals'] },
  { id: 'taxes', name: 'Taxes', excludeFromSpending: true, tracker: true, patterns: ['council tax'] },
  { id: 'groceries', name: 'Groceries', patterns: ['tesco', 'sainsburys', 'ocado'] },
  { id: 'eating-out', name: 'Eating out', patterns: ['pret', 'deliveroo', 'nando', 'the coffee house'] },
  { id: 'transport', name: 'Transport', patterns: ['tfl', 'uber', 'trainline'] },
  { id: 'bills-utilities', name: 'Bills & utilities', patterns: ['octopus energy', 'thames water', 'vodafone'] },
  { id: 'subscriptions', name: 'Subscriptions', patterns: ['netflix', 'spotify', 'puregym'] },
  { id: 'shopping', name: 'Shopping', patterns: ['amazon', 'ikea', 'boots'] },
  { id: 'travel', name: 'Travel', patterns: ['airbnb'] },
  { id: 'cash', name: 'Cash', patterns: ['atm withdrawal'] },
];

const demoDocument = () => ({
  currency: 'GBP', // the generated data is in sterling
  categories: DEMO_CATEGORIES.map((c) => ({
    tracker: false,
    excludeFromSpending: false,
    ...c,
    patterns: [...c.patterns],
  })),
});

/**
 * Create a demo account and return its user row, or null when the instance is
 * already running as many as it allows.
 *
 * The address is unroutable by construction: `.invalid` is reserved by RFC 2606
 * precisely so that a name which must never resolve cannot collide with one
 * that does. It exists because `users.email` is NOT NULL UNIQUE and for no
 * other reason — nothing is ever sent to it, and the app shows "Demo account"
 * in its place.
 *
 * Marked onboarded at creation: setup asks for the two keys a demo will never
 * have, so a demo that had to walk through it would be a demo of the form, not
 * of the dashboard.
 */
async function create() {
  const cap = maxDemoAccounts();
  if (cap && demoIds.size >= cap) return null;

  const email = `demo-${crypto.randomBytes(9).toString('hex')}@demo.invalid`;
  const { rows } = await db.query(
    `INSERT INTO users (email, is_demo, onboarded_at) VALUES ($1, true, now()) RETURNING *`,
    [email]
  );
  const user = rows[0];
  demoIds.add(Number(user.id));

  const saved = await rules.replace(user.id, demoDocument());
  if (saved.error) {
    // The starting document is a constant in this file, so this is a bug in it
    // rather than anything the visitor did — but a demo with no categories is
    // worse than no demo, and leaving the row behind would hold a place under
    // the cap for an account nobody can use.
    await destroy(user.id);
    throw new Error(`Demo categories rejected: ${saved.error}`);
  }
  return user;
}

/**
 * Delete one demo account and everything it owns.
 *
 * `onDelete` is how the in-process caches are cleared without this module
 * having to require src/summary.js and src/gpt.js — both of which ask *this*
 * module whether a user is a demo, so requiring them here would be a cycle.
 * server.js passes the same two calls the account-deletion route makes.
 */
let onDelete = () => {};

async function destroy(userId) {
  const id = Number(userId);
  try {
    onDelete(id);
  } catch (err) {
    console.error(`Clearing caches for demo account ${id} failed:`, err.message);
  }
  await users.deleteAccount(id);
  forget(id);
}

/**
 * Delete demo accounts nobody is using: no unexpired session points at them.
 *
 * The grace period is not about slow visitors, it is about the gap between the
 * INSERT and the session row being written — a reap landing in that window
 * would delete an account whose owner is mid-redirect. Ten minutes is far
 * longer than that gap and far shorter than a session.
 */
const REAP_GRACE_MS = 10 * 60 * 1000;

async function reap() {
  const { rows } = await db.query(
    `SELECT u.id FROM users u
     WHERE u.is_demo
       AND u.created_at < now() - make_interval(secs => $1)
       AND NOT EXISTS (
         SELECT 1 FROM user_sessions s
         WHERE s.expire > now() AND (s.sess->>'userId') ~ '^[0-9]+$'
           AND (s.sess->>'userId')::bigint = u.id
       )`,
    [REAP_GRACE_MS / 1000]
  );
  let removed = 0;
  for (const row of rows) {
    try {
      await destroy(row.id);
      removed++;
    } catch (err) {
      console.error(`Could not reap demo account ${row.id}:`, err.message);
    }
  }
  if (removed) console.log(`Reaped ${removed} finished demo account(s); ${demoIds.size} still live`);
  return removed;
}

/**
 * Load the known demo ids and start reaping. Returns a stop function.
 *
 * Reaping on boot as well as on a timer means a process that was down while
 * sessions expired catches up immediately rather than an interval later.
 */
function start({ intervalMs = 15 * 60 * 1000, onDelete: cleanup } = {}) {
  if (cleanup) onDelete = cleanup;
  const tick = () => reap().catch((err) => console.error('Demo reaper failed:', err.message));
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  load()
    .then((n) => {
      if (n) console.log(`${n} demo account(s) restored from the database`);
      tick();
    })
    .catch((err) => console.error('Could not load demo accounts:', err.message));
  return () => clearInterval(timer);
}

module.exports = {
  isDemo, create, destroy, reap, load, start, forget, liveCount,
  maxDemoAccounts, demoDocument,
  DEMO_TTL_MS, DEMO_CATEGORIES,
};

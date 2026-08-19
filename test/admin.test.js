'use strict';

// The operator panel: who can reach it, and whether its numbers are real.
//
// The access tests matter more than they look. The panel reports every
// account's email and spend, so "any signed-in stranger" reaching it would be a
// data breach rather than an untidy route — and its HTML lives outside public/
// precisely so express.static cannot serve it, which is a property worth
// holding onto with a test.

process.env.MOCK_DATA = '1';
process.env.ADMIN_EMAILS = 'boss@example.com, Second.Admin@Example.com';
delete process.env.GOOGLE_CLIENT_ID; // lets the passwordless dev login stand in
delete process.env.GOOGLE_CLIENT_SECRET;

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const auth = require('../src/auth');

let base = null;

test.before(async () => {
  if (!h.dbAvailable) return;
  await h.initDb();
  const { app } = require('../server');
  await new Promise((resolve) => {
    const server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.unref();
  });
});

// Sign in as `email` and return that session's cookie.
async function signIn(email) {
  const res = await fetch(`${base}/api/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(res.status, 200, 'dev login available');
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const get = (path, cookie) =>
  fetch(base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });

/* ---------- who is an operator ---------- */

test('ADMIN_EMAILS decides, case and spacing insensitively', () => {
  const as = (email) => auth.isAdmin({ session: { email } });
  assert.equal(as('boss@example.com'), true);
  assert.equal(as('BOSS@Example.com'), true, 'the stored email casing must not matter');
  assert.equal(as('second.admin@example.com'), true, 'spaces around a list entry are trimmed');
  assert.equal(as('someone@example.com'), false);
  assert.equal(as(''), false);
  assert.equal(auth.isAdmin({ session: {} }), false);
  assert.equal(auth.isAdmin({}), false);
});

// An unset list must mean "nobody", not "everybody" — a deployment that never
// thought about the panel should not be running one.
test('no ADMIN_EMAILS means no admins', () => {
  const original = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  try {
    assert.equal(auth.isAdmin({ session: { email: 'boss@example.com' } }), false);
  } finally {
    process.env.ADMIN_EMAILS = original;
  }
});

/* ---------- reaching it over HTTP ---------- */

test('a signed-in non-admin is told the panel does not exist', { skip }, async () => {
  const cookie = await signIn(`ordinary-${Date.now()}@example.com`);

  const stats = await get('/api/admin/stats', cookie);
  assert.equal(stats.status, 404, 'not 403 — a 403 confirms there is something there');

  const page = await get('/admin', cookie);
  assert.equal(page.status, 404);

  // The panel would report every account's email, so the page must never be
  // reachable as a static file either. This is why it lives in private/.
  for (const path of ['/admin.html', '/admin.js', '/admin/app.js']) {
    assert.equal((await get(path, cookie)).status, 404, path);
  }
});

test('signed out is sent to the login page, not shown a 404', { skip }, async () => {
  assert.equal((await get('/api/admin/stats')).status, 401);
  const page = await get('/admin');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
});

test('an admin gets the panel and its script', { skip }, async () => {
  const cookie = await signIn('boss@example.com');
  const page = await get('/admin', cookie);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Setup funnel/);
  assert.equal((await get('/admin/app.js', cookie)).status, 200);
});

test('/api/me tells the app whether to show the admin link', { skip }, async () => {
  const admin = await (await get('/api/me', await signIn('boss@example.com'))).json();
  assert.equal(admin.admin, true);
  const ordinary = await (await get('/api/me', await signIn(`plain-${Date.now()}@example.com`))).json();
  assert.equal(ordinary.admin, false);
});

/* ---------- the numbers ---------- */

// Deliberately no before/after deltas on the totals: `node --test` runs these
// files in parallel against one database, so another file creating or deleting
// an account between two reads would make an exact +1 flap. What is asserted
// instead holds no matter what else is happening — the invariants between the
// numbers, and the specific row this test made.
const step = (doc, name) => doc.funnel.find((s) => s.step === name).count;

test('an account that signs in and stops there sits in the first gap', { skip }, async () => {
  const email = `abandoner-${Date.now()}@example.com`;
  await signIn(email);
  const data = await (await get('/api/admin/stats', await signIn('boss@example.com'))).json();

  const row = data.accounts.find((a) => a.email === email);
  assert.ok(row, 'the account appears in the table');
  assert.equal(row.onboardedAt, null, 'signing in is not finishing setup');
  assert.equal(row.hasLunchflow, false);
  assert.ok(row.signIns30d >= 1, 'its sign-in is the one activity signal there is');

  // Each step is a subset of the one above it; a funnel that widens is a bug.
  const counts = data.funnel.slice(0, 4).map((s) => s.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `step ${i} (${counts[i]}) exceeds step ${i - 1}`);
  }
  // The funnel and the headline tiles must be counting the same thing.
  assert.equal(step(data, 'Signed in'), data.totals.total);
  assert.equal(step(data, 'Finished setup'), data.totals.onboarded);
});

test('finishing setup moves an account down the funnel', { skip }, async () => {
  const email = `finisher-${Date.now()}@example.com`;
  const cookie = await signIn(email);
  const before = await (await get('/api/admin/stats', await signIn('boss@example.com'))).json();
  assert.ok(!before.accounts.find((a) => a.email === email).onboardedAt);

  await fetch(`${base}/api/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ lunchflow: 'lf-key', openai: 'oa-key', currency: 'EUR' }),
  });

  const after = await (await get('/api/admin/stats', await signIn('boss@example.com'))).json();
  const row = after.accounts.find((a) => a.email === email);
  assert.ok(row.onboardedAt, 'now carries a setup date');
  assert.equal(row.hasLunchflow, true);
  assert.equal(row.hasOpenai, true);
  assert.equal(row.currency, 'EUR', 'and the currency it chose during setup');
  assert.ok(row.categories >= 1, 'and the rules document setup wrote');
  assert.ok(step(after, 'Finished setup') >= step(before, 'Finished setup') + 1);
});

test('signups cover twelve months, oldest first, including empty ones', { skip }, async () => {
  const data = await (await get('/api/admin/stats', await signIn('boss@example.com'))).json();
  assert.equal(data.signups.length, 12);
  const months = data.signups.map((m) => m.month);
  assert.deepEqual([...months].sort(), months, 'oldest first');
  for (const m of data.signups) {
    assert.match(m.month, /^\d{4}-\d{2}$/);
    assert.ok(Number.isInteger(m.signups), 'a month nobody signed up in is 0, not missing');
  }
  assert.ok(data.signups.at(-1).signups >= 1, 'this month has the accounts these tests made');
});

// Anonymous sessions exist — the OAuth round-trip stores its state in one — and
// they carry no user id. The session queries must skip them rather than fail
// casting an absent id to a bigint.
test('sessions without an account do not break the statistics', { skip }, async () => {
  await h.query(
    `INSERT INTO user_sessions (sid, sess, expire)
     VALUES ('admin-test-anon', '{"cookie":{},"oauthState":"xyz"}'::jsonb, now() + interval '1 day')
     ON CONFLICT (sid) DO NOTHING`
  );
  try {
    const res = await get('/api/admin/stats', await signIn('boss@example.com'));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Number.isInteger(data.engagement.signIns30d));
  } finally {
    await h.query("DELETE FROM user_sessions WHERE sid = 'admin-test-anon'");
  }
});

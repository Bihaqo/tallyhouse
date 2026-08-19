'use strict';

// The turned-away path, end to end over real HTTP.
//
// The interesting part is not the cap arithmetic (test/signup-cap.test.js covers
// that) but the session: someone the cap refuses has no account, so the address
// Google verified has to survive on an anonymous session for the waiting-list
// offer to work at all. With saveUninitialized:false that only happens because
// the callback writes to the session before saving it, which is exactly the kind
// of thing a unit test cannot see.

process.env.MOCK_DATA = '1';
process.env.MAX_USERS = '1'; // occupied below, so the sign-in under test is refused
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const skip = h.skip;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

let base = null;
let visitor = null;

test.before(async () => {
  if (!h.dbAvailable) return;
  await h.initDb();
  await h.freshUser(); // take the single place MAX_USERS allows

  visitor = `turned-away-${process.pid}-${Date.now()}@example.com`;

  // Stand in for Google's token endpoint. It has to exist before src/auth is
  // required, which reads the endpoint at module load.
  const stub = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id_token: `header.${b64({
        iss: 'https://accounts.google.com',
        aud: 'test-client-id',
        sub: `sub-${visitor}`,
        email: visitor,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}.signature`,
    }));
  });
  await new Promise((resolve) => stub.listen(0, resolve));
  stub.unref();
  process.env.GOOGLE_TOKEN_ENDPOINT = `http://127.0.0.1:${stub.address().port}/token`;

  const { app } = require('../server');
  await new Promise((resolve) => {
    const server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.unref();
  });
});

test('the sign-in page is told registrations are paused', { skip }, async () => {
  const cfg = await (await fetch(`${base}/api/auth-config`)).json();
  assert.equal(cfg.atCapacity, true);
  // The button has to stay: the cap refuses new accounts, not existing ones.
  assert.equal(cfg.google, true);
});

test('a sign-in the cap refuses lands on the waiting-list offer', { skip }, async () => {
  // Start the OAuth round-trip, which puts the CSRF state in a fresh session.
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.ok(state, 'the consent redirect carries a state');

  // Come back as Google does. There is no room, so no account is created.
  const back = await fetch(`${base}/auth/google/callback?code=abc&state=${state}`, {
    redirect: 'manual',
    headers: { Cookie: cookie },
  });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/login?closed=1');

  const created = await h.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [visitor]);
  assert.equal(created.rows[0].n, 0, 'turned away, not created');

  // The offer itself: no request body, because the address is the one Google
  // verified a moment ago and the server still has it.
  const joined = await fetch(`${base}/api/waitlist`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(joined.status, 200);
  assert.equal((await joined.json()).email, visitor);

  const listed = await h.query('SELECT count(*)::int AS n FROM waitlist WHERE email = $1', [visitor]);
  assert.equal(listed.rows[0].n, 1);

  // Clicking twice is not an error and does not duplicate the entry.
  const again = await fetch(`${base}/api/waitlist`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(again.status, 200);
  const still = await h.query('SELECT count(*)::int AS n FROM waitlist WHERE email = $1', [visitor]);
  assert.equal(still.rows[0].n, 1);
});

test('the waiting list takes no address from the request itself', { skip }, async () => {
  // Without a refused sign-in behind it there is nothing to add. If this ever
  // starts reading the body, it becomes a way to write arbitrary addresses in.
  const res = await fetch(`${base}/api/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'someone-else@example.com' }),
  });
  assert.equal(res.status, 400);

  const leaked = await h.query('SELECT count(*)::int AS n FROM waitlist WHERE email = $1', [
    'someone-else@example.com',
  ]);
  assert.equal(leaked.rows[0].n, 0);
});

test('capacity is visible to a signed-in account and nobody else', { skip }, async () => {
  assert.equal((await fetch(`${base}/api/capacity`)).status, 401);
});

'use strict';

// Feedback: the one thing an operator reads that belongs to a named account.
//
// What the tests hold is the consent story, because that is what makes reading
// it fair. A message is stored only when somebody wrote one; a picture only
// when it was sent; and both go when the account does — a screenshot of
// somebody's balances must not outlive "delete my account and everything in
// it". The rest is the ordinary care owed to a blob that gets handed back to a
// browser as an image.

process.env.MOCK_DATA = '1';
process.env.ADMIN_EMAILS = 'boss@example.com';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const feedback = require('../src/feedback');

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

async function signIn(email) {
  const res = await fetch(`${base}/api/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const post = (path, cookie, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });

// The smallest valid PNG: an 1x1 image, so the magic-number check has something
// real to accept rather than a string that merely starts the right way.
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const mine = async (email) => (await feedback.list({ limit: 200 })).filter((f) => f.email === email);

/* ---------- sending ---------- */

test('a message is stored with the page it was sent from', { skip }, async () => {
  const email = `fb-${Date.now()}@example.com`;
  const cookie = await signIn(email);

  const res = await post('/api/feedback', cookie, {
    message: '  The donut legend wraps on my phone.  ',
    page: '/#settings',
  });
  assert.equal(res.status, 200);

  const [row] = await mine(email);
  assert.ok(row, 'it is in the list');
  assert.equal(row.message, 'The donut legend wraps on my phone.', 'trimmed, not mangled');
  assert.equal(row.page, '/#settings');
  assert.equal(row.hasScreenshot, false, 'nothing was attached, so nothing is stored');
  assert.equal(row.fromDemo, false);
});

test('an empty message is refused rather than stored', { skip }, async () => {
  const cookie = await signIn(`fb-empty-${Date.now()}@example.com`);
  for (const message of ['', '   ', null, undefined, 42]) {
    const res = await post('/api/feedback', cookie, { message });
    assert.equal(res.status, 400, String(message));
  }
});

test('signed out, there is nothing to send feedback about', { skip }, async () => {
  assert.equal((await post('/api/feedback', null, { message: 'hello' })).status, 401);
});

test('a picture is stored only when one was sent', { skip }, async () => {
  const email = `fb-shot-${Date.now()}@example.com`;
  const cookie = await signIn(email);

  await post('/api/feedback', cookie, { message: 'no picture with this one' });
  await post('/api/feedback', cookie, { message: 'this one has a picture', screenshot: ONE_PIXEL_PNG });

  const rows = await mine(email);
  assert.equal(rows.length, 2);
  const withShot = rows.filter((r) => r.hasScreenshot);
  assert.equal(withShot.length, 1, 'exactly the one that asked for it');
  assert.ok(withShot[0].screenshotBytes > 0);
});

test('only actual PNG bytes are accepted', { skip }, async () => {
  // The field is stored as a blob and handed back to a browser with an image
  // content type, so "the client said it was a PNG" is not enough.
  const cookie = await signIn(`fb-bad-${Date.now()}@example.com`);
  const bad = [
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/png;base64,PHN2Zz48L3N2Zz4=', // right prefix, wrong bytes
    'https://example.com/not-a-data-url.png',
    'data:image/png;base64,',
    12345,
  ];
  for (const screenshot of bad) {
    const res = await post('/api/feedback', cookie, { message: 'attached', screenshot });
    assert.equal(res.status, 400, String(screenshot).slice(0, 40));
  }
});

test('a picture larger than the limit is refused', { skip }, () => {
  const huge = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(feedback.MAX_SCREENSHOT_BYTES + 1),
  ]);
  assert.throws(
    () => feedback.decodeScreenshot(`data:image/png;base64,${huge.toString('base64')}`),
    /too large/
  );
});

test('a demo can send feedback, and is marked as one', { skip }, async () => {
  // The people trying the demo have the most useful first impressions and the
  // least reason to write them down anywhere else.
  const res = await fetch(`${base}/api/demo`, { method: 'POST' });
  assert.equal(res.status, 200);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];

  const sent = await post('/api/feedback', cookie, { message: 'the demo made this clear, thanks' });
  assert.equal(sent.status, 200);

  const row = (await feedback.list({ limit: 5 }))
    .find((f) => f.message === 'the demo made this clear, thanks');
  assert.ok(row);
  assert.equal(row.fromDemo, true);
  assert.equal(row.email, null, 'a generated .invalid address is not an address to show');
});

/* ---------- reading it ---------- */

test('only an operator can read feedback or its pictures', { skip }, async () => {
  const ordinary = await signIn(`fb-nosy-${Date.now()}@example.com`);
  await post('/api/feedback', ordinary, { message: 'mine', screenshot: ONE_PIXEL_PNG });
  const [row] = await mine((await (await get('/api/me', ordinary)).json()).email);

  for (const path of ['/api/admin/feedback', `/api/admin/feedback/${row.id}/screenshot`]) {
    assert.equal((await get(path, ordinary)).status, 404, `${path} — not even to say it exists`);
    assert.equal((await get(path)).status, 401, `${path} signed out`);
  }

  const boss = await signIn('boss@example.com');
  const list = await get('/api/admin/feedback', boss);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).feedback.length >= 1);
});

test('a picture comes back as a PNG that no cache will keep', { skip }, async () => {
  const cookie = await signIn(`fb-img-${Date.now()}@example.com`);
  await post('/api/feedback', cookie, { message: 'look at this', screenshot: ONE_PIXEL_PNG });
  const email = (await (await get('/api/me', cookie)).json()).email;
  const [row] = await mine(email);

  const boss = await signIn('boss@example.com');
  const res = await get(`/api/admin/feedback/${row.id}/screenshot`, boss);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  // It is a picture of somebody's bank balances: not for a shared cache, and
  // not for a browser to sniff into something else.
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
});

test('a message with no picture has no picture to fetch', { skip }, async () => {
  const cookie = await signIn(`fb-none-${Date.now()}@example.com`);
  await post('/api/feedback', cookie, { message: 'text only' });
  const email = (await (await get('/api/me', cookie)).json()).email;
  const [row] = await mine(email);

  const boss = await signIn('boss@example.com');
  assert.equal((await get(`/api/admin/feedback/${row.id}/screenshot`, boss)).status, 404);
});

/* ---------- getting rid of it ---------- */

test('an operator can delete a message and its picture', { skip }, async () => {
  const email = `fb-del-${Date.now()}@example.com`;
  const cookie = await signIn(email);
  await post('/api/feedback', cookie, { message: 'dealt with', screenshot: ONE_PIXEL_PNG });
  const [row] = await mine(email);

  const boss = await signIn('boss@example.com');
  const res = await fetch(`${base}/api/admin/feedback/${row.id}`, {
    method: 'DELETE',
    headers: { Cookie: boss },
  });
  assert.equal(res.status, 200);
  assert.equal(await feedback.screenshotOf(row.id), null, 'the picture went with it');
  assert.equal((await mine(email)).length, 0);
});

test('deleting an account deletes the feedback and pictures it sent', { skip }, async () => {
  // The promise on the privacy page is "everything attached to it". A picture
  // of their own balances, sent to be helpful, is very much attached to it.
  const email = `fb-account-${Date.now()}@example.com`;
  const cookie = await signIn(email);
  await post('/api/onboarding', cookie, { lunchflow: 'lf-key', currency: 'GBP' });
  await post('/api/feedback', cookie, { message: 'about to go', screenshot: ONE_PIXEL_PNG });
  assert.equal((await mine(email)).length, 1);

  const gone = await post('/api/account/delete', cookie, {});
  assert.equal(gone.status, 200);
  assert.equal((await mine(email)).length, 0, 'no orphaned row, and no orphaned picture');
});

test('a reaped demo leaves its feedback behind', { skip }, async () => {
  // The opposite decision to the one above, and deliberate: there is nothing
  // personal in feedback about invented data, and first impressions are the
  // most useful thing in this table. The account goes; the message stays.
  const demo = require('../src/demo');
  const res = await fetch(`${base}/api/demo`, { method: 'POST' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const note = `demo feedback ${Date.now()}`;
  await post('/api/feedback', cookie, { message: note });

  // By this session's own id: "the newest session" would pick up a real
  // account's, which lasts thirty days to a demo's one.
  const sid = decodeURIComponent(cookie.replace('sid=s%3A', '').split('.')[0]);
  const { rows } = await h.query(
    "SELECT (sess->>'userId')::bigint AS id FROM user_sessions WHERE sid = $1", [sid]
  );
  await demo.destroy(rows[0].id);

  const kept = (await feedback.list({ limit: 200 })).find((f) => f.message === note);
  assert.ok(kept, 'still readable');
  assert.equal(kept.email, null, 'with nobody attached to it any more');
});

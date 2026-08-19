'use strict';

// Request-size limits, over real HTTP.
//
// Node serves every account on one thread, so an oversized request is not just
// slow for whoever sent it — it stalls the process for everyone. A rule preview
// costs (patterns × transactions): against a real 3,878-transaction account,
// 50,000 patterns blocked the event loop for 6.6 seconds, and the old 25MB body
// limit had room for roughly 305,000 of them.

process.env.MOCK_DATA = '1';
delete process.env.GOOGLE_CLIENT_ID; // lets the passwordless dev login stand in
delete process.env.GOOGLE_CLIENT_SECRET;

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

let base = null;
let cookie = '';

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
  // A signed-in, onboarded account: the limits guard authenticated routes.
  const res = await call('/api/dev-login', { email: `limits-${Date.now()}@example.com` });
  assert.equal(res.status, 200, 'dev login available');
  await call('/api/onboarding', { lunchflow: 'lf-key', openai: 'oa-key' });
});

async function call(path, body, method = 'POST') {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('a realistic rule preview is accepted', { skip }, async () => {
  const ok = await call('/api/rules/preview', { patterns: ['pret', 'costa'] });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.count, 'number');
});

test('a rule preview with too many patterns is refused, not executed', { skip }, async () => {
  const flood = await call('/api/rules/preview', {
    patterns: Array.from({ length: 5000 }, (_, i) => `pattern-${i}`),
  });
  assert.equal(flood.status, 400);
  assert.match(flood.body.error, /at most \d+ patterns/);
});

test('an individually enormous pattern is refused', { skip }, async () => {
  const long = await call('/api/rules/preview', { patterns: ['x'.repeat(50000)] });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /at most \d+ characters/);
});

test('too many cached-review ids is refused', { skip }, async () => {
  const many = await call('/api/reviews/cached', {
    ids: Array.from({ length: 50000 }, (_, i) => String(i)),
  });
  assert.equal(many.status, 400);
  assert.match(many.body.error, /at most \d+ ids/);

  const few = await call('/api/reviews/cached', { ids: ['a', 'b'] });
  assert.equal(few.status, 200);
});

test('an oversized body is rejected outright on a normal route', { skip }, async () => {
  // 4MB of JSON: comfortably under the import allowance, far over everything else.
  const res = await fetch(base + '/api/rules/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ patterns: ['x'.repeat(4 * 1024 * 1024)] }),
  });
  assert.equal(res.status, 413, 'payload too large');
});

test('the import route still accepts a large export', { skip }, async () => {
  // Only /api/onboarding keeps the headroom, since an export is legitimately big.
  const padding = Array.from({ length: 20000 }, (_, i) => `tx-${i}`);
  const res = await fetch(base + '/api/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      lunchflow: 'lf', openai: 'oa',
      data: { schemaVersion: 1, data: { overrides: Object.fromEntries(padding.map((k) => [k, 'excluded'])) } },
    }),
  });
  assert.notEqual(res.status, 413, 'an export-sized body is not rejected here');
});

test('an unauthenticated import body is refused before it is parsed', { skip }, async () => {
  // That headroom used to be handed to anyone: the 25MB parser was mounted ahead
  // of the session, so a caller with no account could still make the one shared
  // thread read and parse an arbitrary body, repeatedly.
  //
  // Malformed JSON is what tells the two orderings apart, because both answer a
  // valid anonymous body with 401. Parsing first fails on the syntax and answers
  // 400 (entity.parse.failed); refusing first never looks at the body and answers
  // 401. So the assertion below is really about the ordering, not the status.
  const res = await fetch(base + '/api/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // deliberately no Cookie
    body: '{"data": ',
  });
  assert.equal(res.status, 401, 'refused on the missing session, not on the JSON');
});

/* ---------- rate limits on endpoints that reach a third party ---------- */

test('key operations are rate limited per account', { skip }, async () => {
  // /api/keys hands the supplied key straight to Lunchflow and OpenAI, so an
  // unlimited endpoint is a key-testing oracle. MOCK_DATA skips the live
  // validation, which is exactly what lets this test hammer it.
  let limited = 0;
  let accepted = 0;
  for (let i = 0; i < 30; i++) {
    const res = await call('/api/keys', { lunchflow: `probe-${i}` });
    if (res.status === 429) limited++;
    else accepted++;
  }
  assert.ok(limited > 0, 'the limiter engages');
  assert.ok(accepted <= 20, `no more than the configured 20 got through (saw ${accepted})`);
});

test('the limit is keyed by account, so a different session gets its own budget', { skip }, async () => {
  // Exhausted above. A second account must not inherit the first one's block —
  // and must not be able to escape its own by reconnecting from elsewhere either,
  // which is why the key is the user id rather than the address.
  const exhausted = await call('/api/keys', { lunchflow: 'still-blocked' });
  assert.equal(exhausted.status, 429);

  const previous = cookie;
  cookie = '';
  await call('/api/dev-login', { email: `other-${Date.now()}@example.com` });
  await call('/api/onboarding', { lunchflow: 'lf', openai: 'oa' });
  const fresh = await call('/api/keys', { lunchflow: 'fresh-account' });
  assert.notEqual(fresh.status, 429, 'a separate account is unaffected');
  cookie = previous;
});

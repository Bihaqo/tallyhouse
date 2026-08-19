'use strict';

// Configure the module before requiring it (env is read at load).
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/auth');

function idToken(claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256' })}.${seg(claims)}.sig`;
}

const validClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'test-client-id',
  sub: '1234567890',
  email: 'Sam@Example.com',
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

function mockGoogle(idTokenValue, { ok = true } = {}) {
  global.fetch = async () => ({
    ok,
    status: ok ? 200 : 400,
    json: async () => ({ id_token: idTokenValue }),
    text: async () => 'error body',
  });
}

test('googleEnabled reflects configured credentials; dev login off when Google is on', () => {
  assert.equal(auth.googleEnabled(), true);
  assert.equal(auth.devLoginEnabled(), false);
});

test('googleAuthUrl carries the client id, redirect and state', () => {
  const url = new URL(auth.googleAuthUrl({ redirectUri: 'https://app/cb', state: 'xyz' }));
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app/cb');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(url.searchParams.get('scope'), /email/);
});

test('exchangeCodeForEmail returns the verified lowercase email and subject', async () => {
  const original = global.fetch;
  try {
    mockGoogle(idToken(validClaims()));
    const result = await auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'https://app/cb' });
    assert.equal(result.email, 'sam@example.com');
    assert.equal(result.sub, '1234567890');
  } finally {
    global.fetch = original;
  }
});

test('exchangeCodeForEmail rejects bad audience, unverified email, expiry, issuer, missing sub', async () => {
  const original = global.fetch;
  try {
    mockGoogle(idToken(validClaims({ aud: 'someone-else' })));
    await assert.rejects(auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'x' }), /audience/);

    mockGoogle(idToken(validClaims({ email_verified: false })));
    await assert.rejects(auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'x' }), /not verified/);

    mockGoogle(idToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 })));
    await assert.rejects(auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'x' }), /expired/);

    mockGoogle(idToken(validClaims({ iss: 'https://evil.example' })));
    await assert.rejects(auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'x' }), /issuer/);

    mockGoogle(idToken(validClaims({ sub: undefined })));
    await assert.rejects(auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'x' }), /subject/);

    mockGoogle('anything', { ok: false });
    await assert.rejects(auth.exchangeCodeForEmail({ code: 'c', redirectUri: 'x' }), /token exchange failed/);
  } finally {
    global.fetch = original;
  }
});

test('requireAuth and requireOnboarded gate on the session', () => {
  const res = () => {
    const r = { code: null, body: null };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };
  let nexted = false;
  const next = () => (nexted = true);

  auth.requireAuth({ session: {} }, res(), next);
  assert.equal(nexted, false);

  nexted = false;
  auth.requireAuth({ session: { userId: 1 } }, res(), next);
  assert.equal(nexted, true);

  // Authenticated but not onboarded → 403 with an onboarding flag.
  const r = res();
  auth.requireOnboarded({ session: { userId: 1 } }, r, () => {});
  assert.equal(r.code, 403);
  assert.equal(r.body.onboarding, true);
});

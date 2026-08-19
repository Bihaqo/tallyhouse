'use strict';

// Authentication: Google OAuth is the identity provider. Any Google account can
// sign in; the account is created on first login and then sent to onboarding.
// When Google isn't configured (local dev), a passwordless email login stands in
// so the app is still usable.

const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleEnabled = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// The dev email login is only offered off-Google and outside production.
const devLoginEnabled = () => !googleEnabled() && !IS_PROD;

if (IS_PROD && !googleEnabled()) {
  console.error('Configure Google login (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) in production');
  process.exit(1);
}

/* ---------- Google OAuth (authorization-code flow) ---------- */

const GOOGLE_AUTH_ENDPOINT = process.env.GOOGLE_AUTH_ENDPOINT || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = process.env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';

function randomState() {
  return crypto.randomBytes(32).toString('hex');
}

// The URL to send the browser to for Google's consent screen.
function googleAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params}`;
}

// The id_token payload is a base64url-encoded JSON in the middle segment.
function decodeIdToken(idToken) {
  const payload = String(idToken).split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * Exchange an authorization code for the signed-in identity. The code and the
 * resulting id_token come straight from Google's token endpoint over TLS, so
 * decoding the id_token (after checking issuer/audience/expiry) is sufficient —
 * no separate signature fetch is needed for the code flow. Returns
 * { email, sub } (sub is Google's stable account id), or throws.
 */
async function exchangeCodeForEmail({ code, redirectUri }) {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const { id_token: idToken } = await res.json();
  if (!idToken) throw new Error('Google response had no id_token');

  const claims = decodeIdToken(idToken);
  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!validIssuers.includes(claims.iss)) throw new Error('unexpected id_token issuer');
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('id_token audience mismatch');
  if (!claims.exp || claims.exp * 1000 <= Date.now()) throw new Error('id_token expired');
  if (!claims.email || claims.email_verified !== true) throw new Error('email not verified by Google');
  if (!claims.sub) throw new Error('id_token had no subject');

  return { email: String(claims.email).trim().toLowerCase(), sub: String(claims.sub) };
}

/* ---------- route guards ---------- */

// A valid session. API routes get a 401; the SPA turns that into a redirect.
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// A session that has finished onboarding (keys on file). Returns 403 with an
// onboarding flag so the client can bounce the user to /onboarding.
function requireOnboarded(req, res, next) {
  if (req.session && req.session.userId && req.session.onboarded) return next();
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.status(403).json({ error: 'Onboarding required', onboarding: true });
}

/* ---------- operator access ---------- */

/**
 * Who may see the admin panel, as a comma-separated ADMIN_EMAILS list.
 *
 * Read on every call rather than cached at load, so the list can be changed by
 * restarting with a new value and nothing stale survives. Unset means nobody:
 * the panel has to be switched on deliberately, so a deployment that never
 * thought about it does not quietly expose one.
 */
const adminEmails = () =>
  new Set(
    String(process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );

const isAdmin = (req) =>
  Boolean(req.session && req.session.email && adminEmails().has(String(req.session.email).toLowerCase()));

// Answers as if the route did not exist. An admin panel is worth not
// advertising to signed-in strangers, and 404 says less than 403 does.
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(404).json({ error: 'Not found' });
}

module.exports = {
  requireAuth,
  requireOnboarded,
  isAdmin,
  requireAdmin,
  googleEnabled,
  devLoginEnabled,
  googleAuthUrl,
  exchangeCodeForEmail,
  randomState,
};

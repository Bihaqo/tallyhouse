'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const {
  requireAuth,
  requireOnboarded,
  isAdmin,
  requireAdmin,
  googleEnabled,
  devLoginEnabled,
  googleAuthUrl,
  exchangeCodeForEmail,
  randomState,
} = require('./src/auth');
const {
  getSummary,
  getMonthTransactions,
  getYearTransactions,
  setOverride,
  setCategoryOverride,
  previewRule,
  similarTransactions,
  forgetUser: forgetSummaryUser,
} = require('./src/summary');
const { OVERRIDE_STATES } = require('./src/analytics');
const rules = require('./src/rules');
const currencies = require('./src/currencies');
const admin = require('./src/admin');
const gpt = require('./src/gpt');
const db = require('./src/db');
const users = require('./src/users');
const lunchflow = require('./src/lunchflow');
const { PgSessionStore } = require('./src/pg-session-store');
const { buildExport, applyImport } = require('./src/export');
const sweepScheduler = require('./src/sweep-scheduler');
const demo = require('./src/demo');
const { info: buildInfo } = require('./src/build-info');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const useMock = () => process.env.MOCK_DATA === '1';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

if (!process.env.SESSION_SECRET && IS_PROD) {
  console.error('SESSION_SECRET must be set in production');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for secure cookies

/**
 * Limits on what one request may ask the process to chew through.
 *
 * Node runs this on a single thread, so an oversized request is not just slow
 * for its sender — it stalls everyone. A rule preview costs (patterns ×
 * transactions): measured against a real 3,878-transaction account, 50,000
 * patterns blocked the event loop for 6.6 seconds, and a 25MB body had room for
 * about 305,000 of them. These caps sit far above any real use (the settings
 * textarea sends tens of patterns; the AI reviewer sends one) and far below the
 * point where a request becomes an outage.
 */
const MAX_PREVIEW_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 200;
const MAX_CACHED_REVIEW_IDS = 10000; // a year of transactions for a busy account

// First in the chain, so a response the body parser rejects carries these too.
// A 413 or a malformed-JSON 400 is still a response from this origin, and used
// to go out with no nosniff and no CSP on it.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The session cookie is already `secure`, so it never travels in clear — this
  // is about the first navigation, where a plain-HTTP request could be answered
  // by someone other than us before any redirect happens.
  //
  // Production only, and deliberately not `preload`. The dev copy is served on a
  // shared tailnet hostname, and pinning HTTPS for two years across a name used
  // for other things is not ours to do; preload is likewise near-irreversible.
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      // Inline styles are used for chart swatches and a couple of layout hints.
      // Scripts get no such exemption, which is what makes an injected
      // <script> or onerror= inert even if something reached the DOM as HTML.
      "style-src 'self' 'unsafe-inline'",
      "object-src 'none'", // no plugin content, so nothing to embed through
      "base-uri 'none'", // an injected <base> can't repoint every relative URL
      "form-action 'self'", // and no form can be made to post credentials away
      "frame-ancestors 'none'", // the modern X-Frame-Options: DENY
    ].join('; ')
  );
  next();
});

// The session is established before the body parsers, which is what lets the
// 25MB parser below ask whether the caller is signed in.
const sessionStore = new PgSessionStore();
app.use(
  session({
    name: 'sid',
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

/**
 * Keep a demo session sliding forward while it is being used.
 *
 * A demo account is deleted once no live session points at it, so the session's
 * expiry is the account's lifetime, and a fixed one would delete the account
 * out from under somebody who came back to it the next morning. Renewed only in
 * the second half of its life rather than on every request: `rolling` is off
 * for real sessions, so refreshing means an explicit write plus a Set-Cookie,
 * and doing that per request would be a database write per page view for
 * nothing. At most twice a day per demo, which is invisible.
 */
app.use((req, res, next) => {
  const sess = req.session;
  if (sess && sess.demo && sess.cookie && sess.cookie.maxAge < demo.DEMO_TTL_MS / 2) {
    sess.cookie.maxAge = demo.DEMO_TTL_MS;
    sess.slidAt = Date.now(); // a modification, so the session is saved and the cookie re-sent
  }
  next();
});

/**
 * Only the import carries a whole data export; nothing else needs the headroom,
 * and this parser is mounted before the general one so that route's body is left
 * alone by the 1MB limit.
 *
 * The guard is mounted on the prefix rather than left to the route handlers
 * because reading the body is the expensive part, and a route guard only runs
 * after the parser has already finished. Node parses on the one thread everyone
 * shares, so 25MB of JSON from a caller with no session was a stall for every
 * other request, repeatable and unauthenticated. Refuse it before it is read.
 *
 * Every route under this prefix requires an account anyway, so nothing that used
 * to answer stops answering; an anonymous caller now gets the same 401 from here
 * that it would have got from the handler, only sooner and for a lot less work.
 */
app.use('/api/onboarding', requireAuth);
app.use('/api/onboarding', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '1mb' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

/**
 * Limits for the authenticated endpoints that reach a third party.
 *
 * Keyed by account, not by address. These all sit behind a session, and someone
 * holding one can change IP far more easily than identity — an IP-keyed limit on
 * an authenticated route mostly inconveniences people behind a shared NAT.
 */
const perAccount = (req) => (req.session && req.session.userId ? `u:${req.session.userId}` : `ip:${req.ip}`);

/**
 * Endpoints that take an API key in the body and immediately use it against
 * Lunchflow or OpenAI. Without a limit they are a key-testing oracle: anyone with
 * an account can feed in stolen keys and read the pass/fail, using this server as
 * the one making the requests. /api/onboarding/categories additionally *spends*
 * on whatever key it is handed.
 *
 * Onboarding happens once and key rotation almost never, so twenty per quarter
 * hour is far above honest use and far below useful abuse.
 */
const keyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: perAccount,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many key operations — wait a few minutes and try again' },
});

/**
 * Endpoints that bill the account's own OpenAI key per call. A forced re-review
 * costs real money every time and is otherwise unbounded, so a loop over one row
 * could run up a bill. Generous enough that clicking through a month of rows
 * never notices, and still bounded: measured over a real account a review costs
 * about $0.01 — mostly the merchant web search, not tokens — so this caps a
 * runaway at roughly $2 an hour.
 *
 * The background sweep is deliberately not limited: the client fires it on every
 * page load, it returns the existing progress when one is already running, and
 * its real bound is the review cache rather than the request count.
 */
const aiSpendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 200,
  keyGenerator: perAccount,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI review requests this hour — try again later' },
});

const uid = (req) => req.session.userId;
// Whether this request is being made by a demo account. Read from the session
// rather than from src/demo.js so a route can answer it without a database
// lookup; the two agree because the flag is written when the session is created
// and a demo account is deleted with its session.
const isDemoReq = (req) => Boolean(req.session && req.session.demo);

/**
 * Refuse the things a demo must not do.
 *
 * Storing a key would make an unauthenticated account start spending real
 * money; joining the waiting list would write an address nobody verified; an
 * import would put somebody's real finances into an account built to be
 * deleted. Each is refused with the reason rather than a bare 403, because the
 * person hitting it is mid-demo and the answer is "sign in", not "no".
 */
const refuseInDemo = (what) => (req, res, next) => {
  if (!isDemoReq(req)) return next();
  res.status(403).json({ error: `${what} in the demo — sign in with Google to set up a real account` });
};

/**
 * The answer to someone who finished setup with nowhere to put them.
 *
 * The cap counts accounts that finished setup, so it is possible to sign in
 * while there is room and reach the end of setup after the last place has gone.
 * Rare, and worth handling properly rather than with a bare error: the address
 * Google verified is already in the session, so the waiting list is one click
 * away and `full` tells the page to offer it.
 */
function atCapacityAnswer(req) {
  req.session.waitlistEmail = req.session.email;
  return {
    full: true,
    error: 'This instance is full — every place is taken by an account that has finished setup.'
      + ' Your keys and categories are saved, so joining the waiting list is all that is left to do;'
      + ' setup will finish where it stopped once a place opens up.',
  };
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

/**
 * What source this instance is running, for anyone who wants to check.
 *
 * Public and unauthenticated on purpose: it is the answer to "is the site I am
 * typing my bank key into the code that is published?", which is a question
 * asked from outside the account, usually before there is one. It says nothing
 * a reader of the public repo doesn't already have — see src/build-info.js for
 * what the claim is and isn't worth.
 */
app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildInfo);
});

/**
 * Lets the login page decide which controls to show without hardcoding them.
 *
 * `atCapacity` is a bare boolean on purpose. The page needs it to say that new
 * registrations are paused, but the account count is not a number an anonymous
 * visitor has any business reading. The sign-in button stays visible either way —
 * the cap never applies to someone who already has an account here.
 */
app.get('/api/auth-config', async (req, res) => {
  let full = false;
  try {
    full = await users.atCapacity();
  } catch (err) {
    // A capacity probe that fails must not take the login page down with it;
    // worst case the "registrations paused" note is missing and the OAuth
    // callback says so instead.
    console.error('Capacity check failed:', err.message);
  }
  res.json({
    google: googleEnabled(),
    dev: devLoginEnabled(),
    atCapacity: full,
    // The demo is offered even when signups are paused: it creates no account
    // anyone is kept out of, and someone who cannot sign up yet is exactly the
    // person a demo is for.
    demo: Boolean(demo.maxDemoAccounts()),
  });
});

// The count itself, for whoever is signed in. Cheap, and it saves grepping the
// deploy log to answer "how full is it?".
app.get('/api/capacity', requireAuth, async (req, res) => {
  res.json({ users: await users.countUsers(), cap: users.maxUsers(), waiting: await users.waitingCount() });
});

/* ---------- sign-in ---------- */

// The redirect URI must match one registered on the Google OAuth client. It's
// derived from the incoming request (correct on Railway thanks to trust proxy),
// or pinned with GOOGLE_REDIRECT_URI when you'd rather be explicit.
function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`;
}

// Establish the session for a user row and route them to onboarding or the app.
function startSession(req, res, user, { json = false, demo: isDemo = false } = {}) {
  req.session.regenerate((err) => {
    if (err) {
      if (json) return res.status(500).json({ error: 'Session error' });
      return res.redirect('/login?error=' + encodeURIComponent('Session error, try again'));
    }
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.onboarded = users.isOnboarded(user);
    if (isDemo) {
      // A demo lives exactly as long as its session, so this cookie *is* the
      // account's lifetime — a day rather than the month a real sign-in gets,
      // and slid forward on use by the middleware above.
      req.session.demo = true;
      req.session.cookie.maxAge = demo.DEMO_TTL_MS;
    }
    req.session.save(() => {
      if (json) return res.json({ ok: true, onboarding: !req.session.onboarded });
      res.redirect(req.session.onboarded ? '/' : '/onboarding');
    });
  });
}

// Start the Google sign-in: stash a CSRF state in the session and bounce to the
// consent screen.
app.get('/auth/google', loginLimiter, (req, res) => {
  if (!googleEnabled()) return res.redirect('/login');
  const state = randomState();
  req.session.oauthState = state;
  req.session.save((err) => {
    if (err) return res.redirect('/login?error=' + encodeURIComponent('Session error, try again'));
    res.redirect(googleAuthUrl({ redirectUri: googleRedirectUri(req), state }));
  });
});

// Google redirects back here with the authorization code.
app.get('/auth/google/callback', loginLimiter, async (req, res) => {
  if (!googleEnabled()) return res.redirect('/login');
  const fail = (msg) => res.redirect('/login?error=' + encodeURIComponent(msg));

  const { code, state, error } = req.query;
  if (error) return fail('Google sign-in was cancelled');
  const expected = req.session.oauthState;
  delete req.session.oauthState;
  if (!state || !expected || state !== expected) return fail('Sign-in expired, please try again');
  if (typeof code !== 'string') return fail('Missing authorization code');

  try {
    const { email, sub } = await exchangeCodeForEmail({ code, redirectUri: googleRedirectUri(req) });
    const user = await users.upsertByGoogle({ sub, email });
    // No account, and the cap says we can't make one. Google has just verified
    // this address, so hold it in the session for the waiting-list offer rather
    // than asking the visitor to type it again — that also means /api/waitlist
    // needs no request body, and cannot be used to enter someone else's address.
    if (!user) {
      req.session.waitlistEmail = email;
      return req.session.save(() => res.redirect('/login?closed=1'));
    }
    startSession(req, res, user);
  } catch (err) {
    console.error('Google callback failed:', err.message);
    fail('Google sign-in failed, please try again');
  }
});

/**
 * Join the waiting list, using the address Google verified during the sign-in
 * that was turned away. Takes no input at all: without a `waitlistEmail` in the
 * session there is nothing to add, which keeps this from becoming an open
 * endpoint for writing arbitrary addresses into the table.
 */
app.post('/api/waitlist', loginLimiter, refuseInDemo('The waiting list cannot be joined'), async (req, res) => {
  const email = req.session && req.session.waitlistEmail;
  if (!email) return res.status(400).json({ error: 'Sign in first so we know where to reach you' });
  try {
    await users.addToWaitlist(email);
    res.json({ ok: true, email });
  } catch (err) {
    console.error('Waiting list signup failed:', err.message);
    res.status(500).json({ error: 'Could not add you to the waiting list' });
  }
});

/**
 * Start a demo: a throwaway account on invented data, with no sign-in.
 *
 * Rate-limited with the login limiter because that is what this is — the one
 * other way to get a session — and an unauthenticated endpoint that writes a
 * row needs a ceiling that does not depend on anybody being honest. The cap in
 * src/demo.js is the second one: the limiter bounds how fast demos can be made
 * from one address, the cap bounds how many can exist at all.
 *
 * A visitor who already has a session gets sent to whatever it is: signing in
 * and then clicking "demo" should not quietly replace a real account's session
 * with a fake one.
 */
app.post('/api/demo', loginLimiter, async (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ ok: true, existing: true, onboarding: !req.session.onboarded });
  }
  if (!demo.maxDemoAccounts()) return res.status(404).json({ error: 'The demo is not available here' });
  try {
    const user = await demo.create();
    if (!user) {
      return res.status(503).json({
        error: 'All the demo places are in use right now — try again in a few minutes',
      });
    }
    startSession(req, res, user, { json: true, demo: true });
  } catch (err) {
    console.error('Could not start a demo:', err.message);
    res.status(500).json({ error: 'Could not start the demo' });
  }
});

// Local dev only: passwordless email login when Google isn't configured.
app.post('/api/dev-login', loginLimiter, async (req, res) => {
  if (!devLoginEnabled()) return res.status(403).json({ error: 'Dev login is disabled' });
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Enter a valid email' });
  }
  try {
    const user = await users.upsertByEmail(email);
    startSession(req, res, user, { json: true });
  } catch (err) {
    console.error('Dev login failed:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ---------- onboarding & account ---------- */

app.get('/api/me', requireAuth, async (req, res) => {
  // Whether this account has an OpenAI key, so the app can leave the AI
  // controls off the page rather than offering buttons that answer 503. An
  // account can finish setup without one; Settings switches it on later.
  let aiReview = gpt.usesMockReviews(uid(req));
  if (!aiReview) {
    try {
      aiReview = await users.hasOpenAiKey(uid(req));
    } catch (_err) { /* the rest of this answer is still worth sending */ }
  }
  res.json({
    // A demo account's address is a generated `.invalid` name that exists only
    // because the column is NOT NULL UNIQUE; showing it would be showing a
    // stranger an identifier that means nothing and looks like an account.
    email: isDemoReq(req) ? null : req.session.email,
    demo: isDemoReq(req),
    onboarded: Boolean(req.session.onboarded),
    aiReview,
    // Only so the app can show the link. The panel guards itself.
    admin: isAdmin(req),
  });
});

// The currencies an account can be kept in, for the setup and settings
// dropdowns. Static config, so no per-user work — but behind auth, since only
// signed-in pages ask for it.
app.get('/api/currencies', requireAuth, (_req, res) => {
  res.json({ currencies: currencies.LIST, default: currencies.DEFAULT });
});

// Validate a Lunchflow / OpenAI key with a cheap live call. Skipped in mock
// mode. Returns null when ok, or a user-facing error string.
async function validateKeys({ lunchflow: lfKey, openai: oaKey }) {
  if (useMock()) return null;
  if (lfKey !== undefined) {
    try {
      await lunchflow.getAccounts(lfKey);
    } catch (_err) {
      return 'That Lunchflow key was rejected — check it and try again';
    }
  }
  if (oaKey !== undefined) {
    try {
      const r = await fetch(`${OPENAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${oaKey}` } });
      if (!r.ok) return 'That OpenAI key was rejected — check it and try again';
    } catch (_err) {
      return 'Could not reach OpenAI to verify the key';
    }
  }
  return null;
}

/**
 * What setup can learn from a user's data before any of it has been cached:
 * their distinct merchant names, most frequent first, the currency their money
 * is actually in, and how much there is to review. Read straight from
 * Lunchflow, in one pull, because every one of those questions wants the same
 * twelve months of transactions and onboarding runs before there is a cache to
 * read.
 */
async function scanAccounts(apiKey) {
  const api = useMock() ? require('./src/mock') : lunchflow;
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 11, 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  const accounts = await api.getAccounts(apiKey);
  const active = accounts.filter((a) => !a.status || String(a.status).toLowerCase() !== 'disconnected');
  const perAccount = await Promise.all(
    active.map((a) => api.getTransactions(apiKey, a.id, iso(from), iso(to)))
  );
  const txs = perAccount.flat();
  const counts = new Map();
  const byMonth = new Map();
  for (const tx of txs) {
    const name = String(tx.merchant || tx.description || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
    // What the AI review would look at: money out, settled. The sweep also
    // drops refunds and internal transfers, but recognising those needs rules
    // that do not exist yet — so this is an upper bound, and the setup page
    // says "up to" rather than pretending to a precision it cannot have.
    if (!tx.is_pending && Number(tx.amount) < 0) {
      const month = String(tx.date || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(month)) byMonth.set(month, (byMonth.get(month) || 0) + 1);
    }
  }
  return {
    merchants: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name),
    // Only a suggestion — the setup form shows it as the preselected option and
    // the user can pick something else before anything is saved. Null when the
    // data says nothing, which the form says rather than dressing up a default
    // as a detection.
    currency: currencies.detect({ txs, accounts: active }),
    accounts: active.length,
    transactions: txs.length,
    // Newest month first, so the cost estimate can sum the N months the user
    // asks for without knowing today's date on the client.
    months: [...byMonth.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([month, transactions]) => ({ month, transactions })),
  };
}

/**
 * The Lunchflow pull that setup's first step made, kept for the steps after it.
 *
 * The scan is the slow part of setup — every account, twelve months, before any
 * of it is cached — and the two later steps both need it: the category
 * suggestion wants the merchant names, and the cost estimate wants the monthly
 * counts. Holding it here means answering "next" is instant and the user's bank
 * is not asked the same question three times.
 *
 * In process, like the other per-user caches here, and deliberately short-lived:
 * it holds a list of merchant names, which is personal data, for an account that
 * has not finished setting up. Dropped when setup finishes, when the account is
 * deleted, and half an hour after it was taken — after which the next step pays
 * for a fresh pull rather than working from a stale one.
 */
const SCAN_TTL_MS = 30 * 60 * 1000;
const scans = new Map();

function rememberScan(userId, scan) {
  const now = Date.now();
  for (const [id, entry] of scans) if (now - entry.at > SCAN_TTL_MS) scans.delete(id);
  scans.set(userId, { at: now, scan });
}

function recallScan(userId) {
  const entry = scans.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.at > SCAN_TTL_MS) {
    scans.delete(userId);
    return null;
  }
  return entry.scan;
}

const forgetScan = (userId) => scans.delete(userId);

/**
 * Step one of setup: prove the Lunchflow key works and say what is behind it.
 *
 * Deliberately a wall rather than a validation message. A key that authenticates
 * but has no bank connected to it yet — which is every key made in the Lunchflow
 * dashboard before the connection step — produces an account with no
 * transactions, no suggestible categories and an empty dashboard, and the person
 * who set it up has no way to tell that from the app being broken. Failing here
 * says which of the two it is while they are still in the place that can fix it.
 */
app.post('/api/onboarding/scan', requireAuth, keyLimiter, async (req, res) => {
  const { lunchflow: lfKey } = req.body || {};
  if (typeof lfKey !== 'string' || !lfKey.trim()) {
    return res.status(400).json({ error: 'Your Lunchflow API key is required' });
  }
  try {
    const invalid = await validateKeys({ lunchflow: lfKey.trim() });
    if (invalid) return res.status(400).json({ error: invalid });

    const scan = await scanAccounts(lfKey.trim());
    if (!scan.accounts) {
      return res.status(400).json({
        error: 'That key works, but no accounts are connected to it yet — connect your bank in the '
          + 'Lunchflow dashboard, then come back and try again',
      });
    }
    if (!scan.transactions) {
      return res.status(400).json({
        error: `Lunchflow has ${scan.accounts} account(s) for that key but no transactions in the last `
          + '12 months — if you have only just connected your bank, give the first sync a few minutes '
          + 'and try again',
      });
    }
    rememberScan(uid(req), scan);
    res.json({
      accounts: scan.accounts,
      transactions: scan.transactions,
      merchants: scan.merchants.length,
      currency: scan.currency,
      months: scan.months,
      // The per-review halves, so the estimate on the next step can follow the
      // months field and the web-search box without a round trip each keystroke.
      cost: gpt.costBasis(),
      // Whether the categories step may offer to propose a list on this
      // instance's key, for someone setting up without an OpenAI key of their
      // own. False when the instance has no key for it, and false once this
      // account has had its one.
      hostedSuggestion: gpt.hostedSuggestionAvailable()
        && !(await users.hostedSuggestionUsed(uid(req))),
    });
  } catch (err) {
    console.error('Account scan failed:', err.message);
    res.status(502).json({ error: err.publicMessage || 'Could not read your accounts from Lunchflow' });
  }
});

/**
 * Propose a starting category list from the user's own transactions.
 *
 * One model call, using the merchant names the scan step already pulled. A new
 * account ships with no keyword patterns (they are personal data, so none are
 * committed to this repo), which would otherwise leave the first dashboard as a
 * single "Other" wedge.
 *
 * Whose key pays depends on what setup was given. With an OpenAI key, it is
 * theirs and the spend joins their running total. Without one — which is now a
 * way to finish setup, with the AI review simply off — the instance offers its
 * own key for this one call, once per account, and the user is asked first: the
 * request is a list of the places they pay, and it is not their bill.
 *
 * Names and flags only. A wrong category name costs a rename; a wrong keyword
 * pattern silently moves real money into the wrong total, so patterns stay with
 * the per-row review, where the preview shows what each one would catch first.
 */
app.post('/api/onboarding/categories', requireAuth, keyLimiter, async (req, res) => {
  const { lunchflow: lfKey, openai: oaKey } = req.body || {};
  const ownKey = typeof oaKey === 'string' && oaKey.trim() ? oaKey.trim() : null;
  if (typeof lfKey !== 'string' || !lfKey.trim()) {
    return res.status(400).json({ error: 'Your Lunchflow API key is required' });
  }
  if (!ownKey && !gpt.hostedSuggestionAvailable()) {
    return res.status(503).json({
      error: 'This instance cannot suggest categories without a key — add your own OpenAI key, or '
        + 'create your categories by hand',
    });
  }
  try {
    // The Lunchflow key was checked by the scan step; only the new one needs it.
    if (ownKey) {
      const invalid = await validateKeys({ openai: ownKey });
      if (invalid) return res.status(400).json({ error: invalid });
    }

    let scan = recallScan(uid(req));
    if (!scan) {
      // Setup left open for half an hour, or a restart. Pay for the pull again
      // rather than send the model a list from a key that may since have changed.
      scan = await scanAccounts(lfKey.trim());
      rememberScan(uid(req), scan);
    }
    const { merchants, currency } = scan;
    if (!merchants.length) {
      return res.json({ categories: [], currency, note: 'No transactions found to base categories on.' });
    }

    let suggestion;
    if (ownKey) {
      suggestion = await gpt.suggestCategories({
        apiKey: ownKey, merchants, currency: currency || currencies.DEFAULT,
      });
      // This spends the user's own OpenAI money, so it belongs in the running
      // total shown in Settings — but it is not a transaction review, so it must
      // not inflate the review count or the per-review average.
      await gpt.recordUsage(uid(req), suggestion.usage, { countsAsReview: false });
    } else {
      // Claimed before the call, not after: setup is a page anyone can reload,
      // and the claim is what stops one account spending the operator's money
      // more than once.
      if (!(await users.claimHostedSuggestion(uid(req)))) {
        return res.status(409).json({
          error: 'The one suggestion this instance runs for you has already been used on this '
            + 'account — add your own OpenAI key to run it again, or add categories by hand',
        });
      }
      try {
        suggestion = await gpt.suggestCategoriesOnHostKey({
          merchants, currency: currency || currencies.DEFAULT,
        });
      } catch (err) {
        // A call that produced nothing billed nobody, so it must not cost the
        // user their one go.
        await users.releaseHostedSuggestion(uid(req)).catch(() => {});
        throw err;
      }
      // Deliberately not passed to gpt.recordUsage: "AI review spend" is what
      // this account has been billed for, and this was not billed to them. It is
      // logged instead, so whoever pays for it can see it happening.
      console.log(`Category suggestion run on the instance key for user ${uid(req)}`);
    }
    res.json({
      categories: suggestion.categories,
      currency,
      merchantsConsidered: suggestion.considered,
      merchantsTotal: merchants.length,
      hosted: !ownKey, // whose key paid, so the page can say so and not offer twice
    });
  } catch (err) {
    console.error('Category suggestion failed:', err.message);
    res.status(err.status || 502).json({ error: err.publicMessage || 'Could not suggest categories' });
  }
});

/**
 * The AI settings setup chose, validated before they reach the rules document.
 * Returns { settings } or { error }; an absent `ai` object is not an error, it
 * just leaves the account on the deployment defaults.
 */
function parseAiSettings(ai) {
  if (ai == null) return { settings: {} };
  if (typeof ai !== 'object' || Array.isArray(ai)) return { error: 'ai must be an object' };
  const settings = {};
  if (ai.months !== undefined) {
    const months = Number(ai.months);
    if (!Number.isInteger(months) || months < 1 || months > rules.MONTHS_MAX) {
      return { error: `Months to review must be a whole number between 1 and ${rules.MONTHS_MAX}` };
    }
    settings.months = months;
  }
  if (ai.webSearch !== undefined) {
    if (typeof ai.webSearch !== 'boolean') return { error: 'ai.webSearch must be true or false' };
    settings.webSearch = ai.webSearch;
  }
  return { settings };
}

/**
 * Finish onboarding: store the keys (validated), apply the AI settings and
 * optionally import a data export, then mark the account ready.
 *
 * Only the Lunchflow key is required. An account can be set up without an OpenAI
 * key, which leaves the AI review off — no sweep, no per-row verdicts, no spend
 * — and adding one in Settings later switches it on. The AI settings are stored
 * either way, so switching it on then starts from the modest window setup
 * offered rather than the deployment-wide default.
 */
app.post('/api/onboarding', requireAuth, refuseInDemo('Setup cannot be run'), keyLimiter, async (req, res) => {
  const { lunchflow: lfKey, openai: oaKey, data, categories, currency, ai } = req.body || {};
  if (typeof lfKey !== 'string' || !lfKey.trim()) {
    return res.status(400).json({ error: 'Your Lunchflow API key is required' });
  }
  const openai = typeof oaKey === 'string' && oaKey.trim() ? oaKey.trim() : null;
  const { settings: aiSettings, error: aiError } = parseAiSettings(ai);
  if (aiError) return res.status(400).json({ error: aiError });
  try {
    // Asked before anything is stored or validated, so a full instance refuses
    // at the start rather than after taking somebody's API key and spending a
    // round-trip checking it. This is the courteous check, not the enforcing
    // one — claimAccountPlace below is what actually holds under a race.
    if (!users.isOnboarded(await users.byId(uid(req))) && (await users.atCapacity())) {
      return res.status(403).json(atCapacityAnswer(req));
    }
    const invalid = await validateKeys({
      lunchflow: lfKey.trim(),
      ...(openai ? { openai } : {}),
    });
    if (invalid) return res.status(400).json({ error: invalid });
    // Only the keys that were given: an absent OpenAI key leaves the column
    // null rather than writing an empty one, which is what everything
    // downstream tests for.
    await users.setKeys(uid(req), { lunchflow: lfKey.trim(), ...(openai ? { openai } : {}) });
    if (data != null) await applyImport(uid(req), data);
    // The categories the user ticked on the suggestion list, and the currency
    // they confirmed. An import brings its own rules, so it wins and those two
    // are ignored; otherwise a document is written even when nothing was ticked,
    // because skipping the categories is not a reason to lose the currency.
    //
    // The AI settings are applied either way. They were chosen a step before the
    // categories and describe what this account will spend on reviews, which an
    // imported document from another account has nothing to say about.
    const base = data == null
      ? rules.documentFromSuggestions(Array.isArray(categories) ? categories : [], { currency })
      : await rules.get(uid(req));
    const saved = await rules.replace(uid(req), rules.withAiSettings(base, aiSettings));
    if (saved.error) return res.status(400).json({ error: `Category list rejected: ${saved.error}` });
    // The place is taken here, at the end, because everything above can still
    // fail and an account marked as finished without keys is worse than one
    // that has to try again. If the last place went to somebody else while this
    // request was validating keys, the answer is the waiting list — the keys
    // and categories just written stay on the account, so finishing later when
    // a place frees up costs nothing to redo.
    if (!(await users.claimAccountPlace(uid(req)))) {
      return res.status(403).json(atCapacityAnswer(req));
    }
    forgetScan(uid(req)); // setup is over; the merchant list has served its purpose
    req.session.onboarded = true;
    req.session.save(() => res.json({ ok: true }));
  } catch (err) {
    console.error('Onboarding failed:', err.message);
    res.status(400).json({ error: err.message || 'Setup failed' });
  }
});

// Which keys are on file (never the values), for the settings card.
app.get('/api/keys', requireOnboarded, async (req, res) => {
  const keys = await users.getKeys(uid(req));
  res.json({ lunchflow: Boolean(keys.lunchflow), openai: Boolean(keys.openai) });
});

/**
 * Rotate keys from settings (validated), or take the OpenAI one off the account.
 *
 * An explicit `null` for `openai` removes it, which is what makes the AI review
 * genuinely optional rather than optional-until-you-try-it: the review, the
 * sweep and the background scheduler all key off the column being non-null, so
 * clearing it stops every one of them. Cached reviews are left alone — they are
 * paid for and they are the user's data. Only the OpenAI key can go; without a
 * Lunchflow key there is nothing to show at all.
 */
app.post('/api/keys', requireOnboarded, refuseInDemo('API keys cannot be stored'), keyLimiter, async (req, res) => {
  const patch = {};
  if (typeof req.body?.lunchflow === 'string' && req.body.lunchflow.trim()) patch.lunchflow = req.body.lunchflow.trim();
  if (typeof req.body?.openai === 'string' && req.body.openai.trim()) patch.openai = req.body.openai.trim();
  else if (req.body?.openai === null) patch.openai = null;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Provide a new key to update' });
  try {
    // A key being removed has nothing to check with the service that issued it.
    const invalid = await validateKeys(
      Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null))
    );
    if (invalid) return res.status(400).json({ error: invalid });
    await users.setKeys(uid(req), patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('Key update failed:', err.message);
    res.status(500).json({ error: 'Could not update keys' });
  }
});

/* ---------- dashboard data (all scoped to the signed-in user) ---------- */

app.get('/api/summary', requireOnboarded, async (req, res) => {
  try {
    res.json(await getSummary(uid(req), { force: req.query.refresh === '1' }));
  } catch (err) {
    console.error('summary failed:', err.message);
    res.status(502).json({ error: err.publicMessage || 'Failed to load data from Lunchflow' });
  }
});

app.get('/api/transactions', requireOnboarded, async (req, res) => {
  const { month, range } = req.query;
  try {
    if (range === 'year') return res.json(await getYearTransactions(uid(req)));
    if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) {
      return res.json(await getMonthTransactions(uid(req), month));
    }
    return res.status(400).json({ error: 'provide month=YYYY-MM or range=year' });
  } catch (err) {
    console.error('transactions failed:', err.message);
    res.status(502).json({ error: err.publicMessage || 'Failed to load data from Lunchflow' });
  }
});

// Manually classify a transaction. `state` is 'spend' (force ordinary
// spending), 'excluded' (drop from every chart), or null to clear it.
// `categoryId` pins any category — tracker and transfer categories included,
// which is how the row dropdown marks something an investment.
app.post('/api/transactions/:id/override', requireOnboarded, async (req, res) => {
  const id = req.params.id;
  const { state, categoryId } = req.body || {};
  if (state !== null && state !== undefined && !OVERRIDE_STATES.includes(state)) {
    return res.status(400).json({ error: `state must be null or one of ${OVERRIDE_STATES.join(', ')}` });
  }
  if (categoryId !== undefined && categoryId !== null) {
    if (typeof categoryId !== 'string' || !categoryId.trim()) {
      return res.status(400).json({ error: 'categoryId must be null or a non-empty string' });
    }
    if (!(await rules.categoryIds(uid(req))).includes(categoryId)) {
      return res.status(400).json({ error: `unknown category "${categoryId}"` });
    }
  }
  await setOverride(uid(req), id, state ?? null);
  if (categoryId !== undefined) await setCategoryOverride(uid(req), id, categoryId);
  res.json({ ok: true });
});

// Pin a category for one transaction (an accepted AI suggestion), or null to
// fall back to the keyword rules. Accepts a category name, since that is what
// the AI reviewer speaks, and resolves it to the stable id.
app.post('/api/transactions/:id/category', requireOnboarded, async (req, res) => {
  const { category } = req.body || {};
  if (category !== null && (typeof category !== 'string' || !category.trim())) {
    return res.status(400).json({ error: 'category must be null or a non-empty string' });
  }
  let categoryId = null;
  if (category && category !== 'Other') {
    const doc = await rules.get(uid(req));
    const match = doc.categories.find((c) => c.name.toLowerCase() === category.trim().toLowerCase());
    if (!match) return res.status(400).json({ error: `unknown category "${category}"` });
    categoryId = match.id;
  }
  await setCategoryOverride(uid(req), req.params.id, categoryId);
  res.json({ ok: true });
});

/* ---------- classification rules (editable in the settings UI) ---------- */

// Transactions whose merchant fuzzily resembles this one — shown in the row's
// expanded detail, so spelling variants of one payee are visible in one place.
app.get('/api/transactions/:id/similar', requireOnboarded, async (req, res) => {
  try {
    res.json(await similarTransactions(uid(req), req.params.id));
  } catch (err) {
    console.error('similar transactions failed:', err.message);
    res.status(502).json({ error: 'Failed to load similar transactions' });
  }
});

// The stored document, plus the server's fallbacks for the settings it does not
// have to carry, so the settings form can show them as placeholders rather than
// as choices the account has made. collectSettings() rebuilds the document from
// the form, so these extra fields are never written back.
app.get('/api/rules', requireOnboarded, async (req, res) => {
  const doc = await rules.get(uid(req));
  res.json({
    ...doc,
    openaiConcurrencyDefault: rules.CONCURRENCY_DEFAULT,
    aiMonthsDefault: rules.monthsDefault(),
    aiWebSearchDefault: rules.webSearchDefault(),
    aiMonthsMax: rules.MONTHS_MAX,
  });
});

app.put('/api/rules', requireOnboarded, async (req, res) => {
  const result = await rules.replace(uid(req), req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.rules);
});

// Add a single pattern (used by the add-rule modal): { group, name, pattern }.
app.post('/api/rules/pattern', requireOnboarded, async (req, res) => {
  const { categoryId, name, pattern } = req.body || {};
  const result = await rules.addPattern(uid(req), { categoryId, name, pattern });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.rules);
});

// Dry-run a pattern list against the cached transactions.
app.post('/api/rules/preview', requireOnboarded, async (req, res) => {
  const { patterns } = req.body || {};
  if (!Array.isArray(patterns) || !patterns.length || !patterns.every((p) => typeof p === 'string')) {
    return res.status(400).json({ error: 'patterns must be a non-empty array of strings' });
  }
  if (patterns.length > MAX_PREVIEW_PATTERNS) {
    return res.status(400).json({ error: `at most ${MAX_PREVIEW_PATTERNS} patterns per preview` });
  }
  if (patterns.some((p) => p.length > MAX_PATTERN_LENGTH)) {
    return res.status(400).json({ error: `each pattern must be at most ${MAX_PATTERN_LENGTH} characters` });
  }
  try {
    res.json(await previewRule(uid(req), patterns));
  } catch (err) {
    console.error('rule preview failed:', err.message);
    res.status(502).json({ error: 'Failed to load transactions for the preview' });
  }
});

/* ---------- AI (GPT) transaction reviews ---------- */

// Review one transaction; served from the cache unless ?force=1.
app.post('/api/transactions/:id/review', requireOnboarded, aiSpendLimiter, async (req, res) => {
  try {
    const result = await gpt.review(uid(req), req.params.id, { force: req.query.force === '1' });
    if (!result) return res.status(404).json({ error: 'Unknown transaction id' });
    res.json(result);
  } catch (err) {
    console.error('AI review failed:', err.message);
    res.status(err.status || 502).json({ error: err.publicMessage || 'AI review failed' });
  }
});

// Review the N most recent unclassified ("Other") transactions — capped at 20
// per call. { limit?, force? }. force=true re-runs even cached ones.
app.post('/api/reviews/batch', requireOnboarded, aiSpendLimiter, async (req, res) => {
  const { limit, force } = req.body || {};
  try {
    res.json(await gpt.reviewBatch(uid(req), { limit, force: force === true }));
  } catch (err) {
    console.error('AI batch review failed:', err.message);
    res.status(err.status || 502).json({ error: err.publicMessage || 'AI batch review failed' });
  }
});

// Kick off a background review of every uncached transaction. Returns a status
// snapshot immediately; calling while a sweep runs just reports progress.
app.post('/api/reviews/sweep', requireOnboarded, async (req, res) => {
  try {
    res.json(await gpt.sweep(uid(req)));
  } catch (err) {
    if (err.status !== 503) console.error('AI sweep failed:', err.message);
    res.status(err.status || 502).json({ error: err.publicMessage || 'AI sweep failed' });
  }
});

app.get('/api/reviews/status', requireOnboarded, (req, res) => res.json(gpt.sweepStatus(uid(req))));

// Cumulative OpenAI token usage and estimated spend (shown in settings).
app.get('/api/ai-usage', requireOnboarded, async (req, res) => res.json(await gpt.usageSummary(uid(req))));

// Outliers GPT flagged that no human has looked at yet.
app.get('/api/reviews/outliers', requireOnboarded, async (req, res) => {
  try {
    res.json(await gpt.listOutliers(uid(req)));
  } catch (err) {
    console.error('outlier list failed:', err.message);
    res.status(502).json({ error: 'Failed to load outliers' });
  }
});

// Mark an outlier as reviewed so it leaves the home-page inbox.
app.post('/api/reviews/:id/outlier-reviewed', requireOnboarded, async (req, res) => {
  if (!(await gpt.ackOutlier(uid(req), req.params.id))) {
    return res.status(404).json({ error: 'No outlier review for that transaction' });
  }
  res.json({ ok: true });
});

// Cached reviews for a list of ids — no model calls.
app.post('/api/reviews/cached', requireOnboarded, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
  if (ids.length > MAX_CACHED_REVIEW_IDS) {
    return res.status(400).json({ error: `at most ${MAX_CACHED_REVIEW_IDS} ids per request` });
  }
  res.json(await gpt.cached(uid(req), ids));
});

// Full data export: everything this user owns as one JSON file (sessions/keys
// excluded). Streamed as a download with a dated filename.
app.get('/api/export', requireOnboarded, async (req, res) => {
  try {
    const doc = await buildExport(uid(req), { user: req.session.email });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tallyhouse-export-${stamp}.json"`);
    res.send(JSON.stringify(doc, null, 2));
  } catch (err) {
    console.error('export failed:', err.message);
    res.status(500).json({ error: 'Failed to build export' });
  }
});

/**
 * Erase the account and everything in it. requireAuth rather than
 * requireOnboarded: someone who stopped halfway through setup has a row and a
 * pair of keys, and is exactly the person most likely to want them gone.
 *
 * The in-process caches are cleared before the delete, not after: a sweep or a
 * cache refresh landing between the two would write rows back for a user that
 * is on the way out, and the FK would then reject them.
 */
app.post('/api/account/delete', requireAuth, keyLimiter, async (req, res) => {
  const id = uid(req);
  try {
    gpt.forgetUser(id);
    forgetSummaryUser(id);
    forgetScan(id); // an abandoned setup leaves a merchant list behind it
    await users.deleteAccount(id);
    demo.forget(id); // a no-op unless this was a demo
    // The session row is already gone with the account; this clears the cookie
    // and this process's copy so the next request is a clean signed-out one.
    req.session.destroy(() => res.json({ ok: true }));
  } catch (err) {
    console.error('Account deletion failed:', err.message);
    res.status(500).json({ error: 'Could not delete the account — nothing was removed' });
  }
});

/* ---------- admin ---------- */

// Operator statistics. Everything it reports is derived from data the app
// already stores — see the note at the top of src/admin.js for why that is a
// constraint rather than a limitation.
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await admin.stats());
  } catch (err) {
    console.error('Admin stats failed:', err.message);
    res.status(500).json({ error: 'Could not load statistics' });
  }
});

/* ---------- pages ---------- */

app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  if (!req.session.onboarded) return res.redirect('/onboarding');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// Public on purpose: it's what someone reads before deciding to sign in.
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
// Public for the same reason, and additionally because Google's OAuth consent
// screen requires a reachable privacy policy URL for a published app.
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/onboarding', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  if (req.session.onboarded) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});
/**
 * The admin panel. Nothing to see here unless ADMIN_EMAILS names you — a
 * signed-in stranger gets the same 404 a signed-out one would.
 *
 * Its two files live in private/ rather than public/ precisely because
 * express.static serves everything under public/ to anyone who guesses the
 * name. Being useless without the API would not stop /admin.html from telling a
 * stranger the panel exists and what it measures.
 */
const adminPage = (file) => (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  if (!isAdmin(req)) return next(); // falls through to the 404
  res.sendFile(path.join(__dirname, 'private', file));
};
app.get('/admin', adminPage('admin.html'));
app.get('/admin/app.js', adminPage('admin.js'));

app.get('/vendor/chart.umd.js', (req, res) => {
  // chart.js's package "exports" hides dist/ from require.resolve
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Every route above answers JSON, so failures should too. Express's default
// handler renders an HTML page and, outside production, includes the stack in
// the response — this keeps a rejected body or a malformed payload to a status
// and a sentence, with the detail in the log where it belongs.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Unhandled request error:', err.message);
  const message = status === 413 ? 'Request body is too large'
    : status === 400 && err.type === 'entity.parse.failed' ? 'Request body is not valid JSON'
    : status < 500 ? err.expose ? err.message : 'Bad request'
    : 'Something went wrong';
  res.status(status).json({ error: message });
});

/**
 * Retry a boot step before giving up on the whole process.
 *
 * Railway's private network is not necessarily reachable the instant the
 * container starts, so the first connection to Postgres can be refused on a
 * fresh deploy. Exiting on that turned a two-second wait into a crashed
 * deployment — the platform restarted it, the retry succeeded and the site was
 * fine, but every deploy still sent a "Deploy Crashed!" alert. Waiting is the
 * honest response to a dependency that is merely not ready yet.
 *
 * Each attempt is logged, so if this is what has been happening the deploy log
 * now says so outright instead of leaving it to be inferred.
 */
async function withRetries(label, fn, { attempts = 8, baseMs = 500, maxMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      const wait = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      console.warn(`${label} not ready (attempt ${attempt}/${attempts}): ${err.message} — retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function start() {
  await withRetries('Postgres', () => db.init()); // apply the schema before serving any request
  const fx = require('./src/fx');
  await withRetries('FX table', () => fx.init()); // load the shared FX table into memory
  const mode = useMock() ? 'MOCK DATA' : 'live Lunchflow';
  const server = app.listen(PORT, () => {
    console.log(`Tallyhouse listening on :${PORT} (${mode})`);
  });

  // Drains the AI review backlog without anyone opening the site. Hourly by
  // default; SWEEP_INTERVAL_MINUTES=0 turns it off.
  const stopSweeps = sweepScheduler.start();

  // Loads which accounts are demos and deletes the ones whose session is gone.
  // The two cache clears are the same ones /api/account/delete makes: demo.js
  // cannot require these modules itself without a cycle, since both of them ask
  // it whether a user is a demo.
  const stopDemoReaper = demo.start({
    onDelete: (id) => {
      gpt.forgetUser(id);
      forgetSummaryUser(id);
    },
  });

  // Railway sends SIGTERM when replacing the container on a deploy; finish the
  // in-flight requests and exit 0. Sessions are already in Postgres.
  //
  // This only started running in production once railway.json stopped launching
  // the app through `npm start`. npm ran the script as `sh -c node server.js`,
  // and the deploy log for every single deploy ended:
  //   npm error command failed / npm error signal SIGTERM
  //   npm error command sh -c node server.js
  // with no line from here — so the handler never fired, and npm's non-zero exit
  // was what Railway reported as "Deploy Crashed!". Keep node the process that
  // receives the signal.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${signal} received, shutting down`);
      if (stopSweeps) stopSweeps();
      if (stopDemoReaper) stopDemoReaper();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

// Only boot when run as the program. Requiring this file hands back the express
// app so the tests can exercise real routes — guards, body limits, status codes —
// on an ephemeral port instead of asserting against handlers in isolation.
if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };

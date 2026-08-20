'use strict';

/**
 * Operator statistics, derived entirely from tables the app already keeps.
 *
 * Nothing here observes anybody. There is no event log, no page-view record and
 * no new column: every number below is a count or a timestamp that had to exist
 * for the app to work at all — when an account was created, whether it finished
 * setup, how many rules it wrote. That is a deliberate constraint rather than an
 * implementation detail. The privacy policy says "no analytics, no tracking",
 * and a first-party cookieless event log would still be analytics, so the
 * question this file answers is "what can be known from what is already
 * stored?" and not "what would be useful to record?".
 *
 * Nor does it name anybody. Every figure is a total, a median or an average
 * over accounts; no query here returns an email address or a per-account row,
 * so the panel answers "how is the instance doing?" and cannot be used to look
 * at a person. That is a second constraint on top of the first, and a stricter
 * one: the data to identify an account plainly exists in `users`, and this file
 * declines to select it.
 *
 * The cost is that some obvious questions cannot be answered honestly here, and
 * the panel says so rather than approximating:
 *
 *   - Who anybody is, or what any one account did. By choice, not absence —
 *     the database still knows, and a support request or a deletion goes
 *     through psql, where it takes a deliberate act rather than a glance.
 *   - Which page someone abandoned. Never recorded, so never available.
 *   - When someone was last *active*. transactions_cache.cached_at looks like
 *     it, but the background sweep refreshes it hourly for every onboarded
 *     account, so it measures the scheduler, not the person. Last *sign-in* is
 *     real, and that is what is reported.
 *   - Whether the AI reviews on an account were asked for. The sweep runs them
 *     unprompted, so review counts measure data volume, not engagement.
 *     Manual classification overrides are the honest engagement signal: nothing
 *     creates one except a person clicking.
 */

const db = require('./db');
const { SESSION_TTL_MS } = require('./pg-session-store');

// Sessions are stored by expiry, and `rolling` is off, so a row's expire is
// fixed at sign-in: subtracting the TTL recovers when that session started.
// Rows are pruned once expired, so the sessions table is a rolling window of
// roughly the last 30 days of sign-ins and nothing older.
const SESSION_START = `(expire - interval '${Math.round(SESSION_TTL_MS / 1000)} seconds')`;

// Anonymous sessions exist (the OAuth round-trip stores its state in one), so a
// row only belongs to an account when it carries a numeric user id.
const SESSION_USER = `sess->>'userId'`;
const SESSION_OF_USER = `${SESSION_USER} ~ '^[0-9]+$'`;

/**
 * Run every query in the panel against one consistent view of the database.
 *
 * Without this the numbers are read a few milliseconds apart, and an account
 * created in between makes the headline count and the funnel's first step
 * disagree by one — which reads as a bug in the panel rather than as the two
 * true answers to slightly different moments that it is. REPEATABLE READ costs
 * nothing here (the queries are counts, and this page is not on a hot path) and
 * buys a screen whose numbers add up.
 *
 * Sequential rather than concurrent because a transaction is one connection.
 */
async function snapshot(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Headline counts: how many accounts there are and how fresh they are. */
async function accountTotals(q = db) {
  const { rows } = await q.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE onboarded_at IS NOT NULL)::int AS onboarded,
           count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7d,
           count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30d
    FROM users
  `);
  return rows[0];
}

/** Signups per month for the last twelve, oldest first, gaps filled with zero. */
async function signupsByMonth(q = db) {
  const { rows } = await q.query(`
    SELECT to_char(m, 'YYYY-MM') AS month, count(u.id)::int AS signups
    FROM generate_series(
      date_trunc('month', now()) - interval '11 months',
      date_trunc('month', now()),
      interval '1 month'
    ) AS m
    LEFT JOIN users u ON date_trunc('month', u.created_at) = m
    GROUP BY m ORDER BY m
  `);
  return rows;
}

/**
 * How far accounts get, and where they stop.
 *
 * Setup is one atomic request — keys, rules and the onboarded flag are all
 * written together — so there is no partial state to read and no way to tell a
 * user who abandoned the key form from one who never opened it. Signed in →
 * finished setup is therefore a single step, and it is the big one: everyone
 * who bounces off the Lunchflow key requirement is in that gap.
 *
 * The two steps after it are largely the background sweep proving the keys
 * work, not the person doing anything, which is what the panel labels them as.
 * "AI reviews ran" is also now a real choice rather than a consequence: an
 * account can finish setup with no OpenAI key, and never appear on that row.
 */
async function setupFunnel(q = db) {
  const { rows } = await q.query(`
    SELECT count(*)::int AS "signedIn",
           count(*) FILTER (WHERE u.onboarded_at IS NOT NULL)::int AS onboarded,
           count(*) FILTER (WHERE tc.user_id IS NOT NULL)::int AS "dataPulled",
           count(*) FILTER (
             WHERE coalesce((au.stats->>'totalReviews')::numeric, 0) > 0
           )::int AS reviewed
    FROM users u
    LEFT JOIN transactions_cache tc ON tc.user_id = u.id
    LEFT JOIN ai_usage au ON au.user_id = u.id
  `);
  const { rows: returned } = await q.query(`
    SELECT count(DISTINCT (${SESSION_USER})::bigint)::int AS n
    FROM user_sessions s
    JOIN users u ON u.id = (${SESSION_USER})::bigint
    WHERE ${SESSION_OF_USER}
      AND u.onboarded_at IS NOT NULL
      AND ${SESSION_START} > u.onboarded_at + interval '1 day'
  `);

  const f = rows[0];
  return [
    { step: 'Signed in', count: f.signedIn, note: 'a Google account exists' },
    { step: 'Finished setup', count: f.onboarded, note: 'Lunchflow key accepted' },
    { step: 'Data pulled', count: f.dataPulled, note: 'Lunchflow returned transactions' },
    { step: 'AI reviews ran', count: f.reviewed, note: 'needs an OpenAI key; mostly the sweep' },
    { step: 'Signed in again', count: returned[0].n, note: 'a day or more after setup' },
  ];
}

/**
 * Engagement, from the two things only a person can cause: signing in, and
 * correcting a classification by hand. Both are already stored — sessions
 * because the site needs them to keep you logged in, overrides because they are
 * the user's own data.
 */
async function engagement(q = db) {
  const { rows } = await q.query(`
    SELECT count(*)::int AS "signIns30d",
           count(DISTINCT (${SESSION_USER}))::int AS "accountsSeen30d",
           count(*) FILTER (WHERE ${SESSION_START} > now() - interval '7 days')::int AS "signIns7d"
    FROM user_sessions WHERE ${SESSION_OF_USER}
  `);
  const { rows: work } = await q.query(`
    SELECT (SELECT count(*)::int FROM overrides) AS overrides,
           (SELECT count(DISTINCT user_id)::int FROM overrides) AS "accountsClassifying",
           (SELECT count(*)::int FROM ai_reviews) AS reviews
  `);
  const { rows: spend } = await q.query(`
    SELECT coalesce(sum((stats->>'costUsd')::numeric), 0)::float AS "costUsd",
           coalesce(sum((stats->>'totalReviews')::numeric), 0)::int AS "totalReviews"
    FROM ai_usage
  `);
  return { ...rows[0], ...work[0], ...spend[0] };
}

/** People turned away because signups were full. */
async function waitlist(q = db) {
  const { rows } = await q.query(
    'SELECT count(*)::int AS total, max(created_at) AS latest FROM waitlist'
  );
  return rows[0];
}

/**
 * What a typical set-up account looks like, as medians and averages.
 *
 * This is deliberately not one row per account. Running the instance needs to
 * know the shape of the use — whether people connect one bank or four, whether
 * anyone classifies by hand, what the AI costs them — and none of those
 * questions need a name attached to answer. A table of addresses is also a page
 * that cannot be screenshotted, read over a shoulder, or handed to anyone
 * helping out, and it makes routine curiosity about a specific person the
 * default gesture rather than a deliberate one. Anything genuinely needing an
 * individual (a support request, a deletion) goes through the database, where
 * it is a decision rather than a glance.
 *
 * Only onboarded accounts count. An account that stopped at the key form has a
 * zero in every column here, and including them would make each of these
 * numbers a second, worse reading of the funnel rather than a description of
 * what set-up accounts do.
 *
 * Median as well as average because with a small instance one heavy user drags
 * every mean upward: the pair is what tells you which you are looking at.
 *
 * Deliberately does not touch transactions_cache.txs — it is the biggest column
 * in the database and reading it per account would make this page a heavy query
 * for a number nobody needs. The accounts array beside it is small, so
 * connected-account counts come from there.
 */
async function perAccount(q = db) {
  const { rows } = await q.query(`
    WITH per_account AS (
      SELECT (u.openai_key IS NOT NULL) AS has_openai,
             jsonb_array_length(coalesce(tc.accounts, '[]'::jsonb)) AS bank_accounts,
             jsonb_array_length(coalesce(r.doc->'categories', '[]'::jsonb)) AS categories,
             coalesce(ovr.n, 0) AS overrides,
             coalesce(rev.n, 0) AS reviews,
             coalesce((au.stats->>'costUsd')::numeric, 0) AS cost_usd,
             coalesce(s.n, 0) AS sign_ins,
             s.last_sign_in
      FROM users u
      LEFT JOIN rules r ON r.user_id = u.id
      LEFT JOIN transactions_cache tc ON tc.user_id = u.id
      LEFT JOIN ai_usage au ON au.user_id = u.id
      LEFT JOIN (SELECT user_id, count(*) AS n FROM overrides GROUP BY user_id) ovr ON ovr.user_id = u.id
      LEFT JOIN (SELECT user_id, count(*) AS n FROM ai_reviews GROUP BY user_id) rev ON rev.user_id = u.id
      LEFT JOIN (
        SELECT (${SESSION_USER})::bigint AS user_id,
               count(*) AS n,
               max(${SESSION_START}) AS last_sign_in
        FROM user_sessions WHERE ${SESSION_OF_USER} GROUP BY 1
      ) s ON s.user_id = u.id
      WHERE u.onboarded_at IS NOT NULL
    )
    SELECT count(*)::int AS accounts,
           count(*) FILTER (WHERE has_openai)::int AS "withOpenai",
           count(*) FILTER (WHERE overrides > 0)::int AS "withOverrides",
           count(*) FILTER (WHERE last_sign_in > now() - interval '7 days')::int AS "activeWeek",
           count(*) FILTER (WHERE last_sign_in IS NOT NULL)::int AS "activeMonth",
           coalesce(avg(bank_accounts), 0)::float AS "bankAvg",
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY bank_accounts), 0)::float AS "bankMedian",
           coalesce(avg(categories), 0)::float AS "categoriesAvg",
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY categories), 0)::float AS "categoriesMedian",
           coalesce(avg(overrides), 0)::float AS "overridesAvg",
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY overrides), 0)::float AS "overridesMedian",
           coalesce(avg(reviews), 0)::float AS "reviewsAvg",
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY reviews), 0)::float AS "reviewsMedian",
           coalesce(avg(cost_usd), 0)::float AS "costAvg",
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd), 0)::float AS "costMedian",
           coalesce(avg(sign_ins), 0)::float AS "signInsAvg",
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY sign_ins), 0)::float AS "signInsMedian"
    FROM per_account
  `);
  const r = rows[0];
  return {
    accounts: r.accounts,
    withOpenai: r.withOpenai,
    withOverrides: r.withOverrides,
    activeWeek: r.activeWeek,
    activeMonth: r.activeMonth,
    metrics: [
      { metric: 'Bank accounts', median: r.bankMedian, average: r.bankAvg,
        note: 'connected through Lunchflow' },
      { metric: 'Categories', median: r.categoriesMedian, average: r.categoriesAvg,
        note: 'after setup proposed a starting list' },
      { metric: 'Manual classifications', median: r.overridesMedian, average: r.overridesAvg,
        note: 'the one number nothing but a person creates' },
      { metric: 'AI reviews', median: r.reviewsMedian, average: r.reviewsAvg,
        note: 'mostly the background sweep, not a request' },
      { metric: 'AI spend', median: r.costMedian, average: r.costAvg, unit: 'usd',
        note: "billed to each account's own OpenAI key" },
      { metric: 'Sign-ins', median: r.signInsMedian, average: r.signInsAvg,
        note: 'last 30 days — older sessions are deleted' },
    ],
  };
}

// Everything the panel shows, as one coherent picture of one moment.
async function stats() {
  return snapshot(async (q) => ({
    totals: await accountTotals(q),
    signups: await signupsByMonth(q),
    funnel: await setupFunnel(q),
    engagement: await engagement(q),
    waitlist: await waitlist(q),
    perAccount: await perAccount(q),
    generatedAt: new Date().toISOString(),
  }));
}

module.exports = {
  stats, accountTotals, signupsByMonth, setupFunnel, engagement, waitlist, perAccount,
};

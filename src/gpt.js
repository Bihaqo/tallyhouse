'use strict';

// AI second opinion on transaction classification, via the OpenAI Responses
// API. For each reviewed transaction the model is asked to:
//   1. judge the current category (or suggest one when it's "Other"),
//   2. optionally propose a keyword rule that would classify similar
//      transactions — which it must verify with the preview_rule tool, which
//      shows exactly which existing transactions the rule would match,
//   3. flag outliers, given per-category/merchant stats and the ~100
//      preceding transactions.
// The model also gets OpenAI's built-in web search tool so it can look up
// unfamiliar merchants — both what they sell, and whether they are widely
// reported as a scam, which is flagged rather than quietly categorised. Everything is scoped to one user: reviews, spend, and
// the OpenAI key all belong to the signed-in account. Results are cached in
// Postgres keyed by (user, transaction id); re-running is explicit (?force=1).
//
// One exception, and only one: suggestCategoriesOnHostKey() runs a single
// category suggestion on the deployment's own key, for an account that finished
// setup without giving one. No transaction review ever does.

const crypto = require('crypto');
const rules = require('./rules');
const { classify, currentLabel, previewMatches, matchesAny, merchantSimilarity,
  accountLabels } = require('./analytics');
const db = require('./db');
const users = require('./users');

// Stamped on every stored review so a verdict can be attributed to the prompt
// that produced it. Bump when the prompt or review semantics change. Nothing is
// recomputed automatically on a bump — a cached review is only re-run by the ↻
// button on a row — so raising this is safe and costs nothing.
// 3: reviewer may name non-spending categories, no rules for already-correct
//    transactions, fuzzy merchant stats, refunds no longer presented as income.
// 4: the merchant search is also asked what people say about a payee, so a
//    merchant widely reported as a scam is flagged as an outlier rather than
//    quietly categorised. Guarded against calling one bad review fraud.
// 5: the merchant web search is a per-account setting. With it switched off the
//    reviewer is told it has no web access and asked to say when a payee it
//    cannot recognise is the reason for a low-confidence answer, rather than
//    being told to search with no tool to search with.
const PROMPT_VERSION = 5;
const { getConverted } = require('./summary');
const overrides = require('./overrides');
const currencies = require('./currencies');

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
// "low" keeps reviews fast and cheap; bump via env if the verdicts feel shallow.
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
const MAX_TOOL_ROUNDS = 5;
// The reviewer is asked for one candidate rule at a time; this only bounds a
// malformed or manipulated tool call, not normal use.
const MAX_TOOL_PATTERNS = 10;
// Concurrency is per account now (Settings → AI review), defaulting to
// OPENAI_CONCURRENCY. rules.concurrencyOf() resolves a user's document to it.

// USD per 1M tokens; override when OpenAI's pricing (or the model) changes.
const PRICE_INPUT = Number(process.env.OPENAI_PRICE_INPUT) || 0.25;
const PRICE_CACHED_INPUT = Number(process.env.OPENAI_PRICE_CACHED_INPUT) || 0.025;
const PRICE_OUTPUT = Number(process.env.OPENAI_PRICE_OUTPUT) || 2.0;
// Built-in tools are billed per call on top of the tokens they generate. Only
// web_search costs money; preview_rule runs here, so it is free beyond tokens.
// USD per 1000 web searches — check your OpenAI bill and override if it drifts.
const PRICE_WEB_SEARCH_PER_1K = Number(process.env.OPENAI_PRICE_WEB_SEARCH) || 10.0;

// Mock reviews run in local dev so the review flows are exercisable without an
// OpenAI key or spend. MOCK_REVIEWS turns them on independently of MOCK_DATA,
// which is what a staging copy wants: real transactions, no duplicated spend on
// reviews production has already paid for.
const useMockReviews = () => process.env.MOCK_DATA === '1' || process.env.MOCK_REVIEWS === '1';

/**
 * The deployment's own OpenAI key, used for exactly one thing: the single
 * category suggestion offered during setup to an account that has no key of its
 * own (see suggestCategoriesOnHostKey). Nothing else ever reads it — every
 * transaction review is billed to the account that asked for it.
 *
 * Deliberately not named OPENAI_API_KEY. That name is set in a lot of
 * environments for unrelated reasons, and an instance must not start paying for
 * other people's suggestions because a variable it did not set for this happened
 * to be present. Read per call so it can be added without a restart, and so the
 * tests can exercise both sides of "is this offered at all".
 */
const hostKey = () => (process.env.ONBOARDING_OPENAI_KEY || '').trim();
// Mock reviews stand in for the model, so a dev instance can walk the whole flow
// without a key or a bill — the same exemption review() and sweep() make.
const hostedSuggestionAvailable = () => useMockReviews() || Boolean(hostKey());

// In-flight per (user, tx) so concurrent requests share one call; sweep state
// per user so one account's sweep doesn't clobber another's progress.
const inflightByUser = new Map();
const sweepByUser = new Map();

// Accounts deleted while this process has been up. Cancelling a running sweep
// is not enough on its own: the delete races requests that are already on their
// way in, so a sweep can *start* after the account is gone and there is then no
// state to cancel. Every such review is billed to a key whose owner has left
// and then rejected by the foreign key, so the check has to outlive the sweep.
// Ids are BIGSERIAL and never reused, so a tombstone can never block a real
// account, and one integer per departed user is not worth expiring.
const forgottenUsers = new Set();

function inflightFor(userId) {
  let m = inflightByUser.get(userId);
  if (!m) inflightByUser.set(userId, (m = new Map()));
  return m;
}

/* ---------- review persistence (Postgres) ---------- */

async function getReview(userId, id) {
  const { rows } = await db.query('SELECT review FROM ai_reviews WHERE user_id = $1 AND tx_id = $2', [userId, id]);
  return rows.length ? rows[0].review : null;
}

async function putReview(userId, id, review) {
  await db.query(
    `INSERT INTO ai_reviews (user_id, tx_id, review) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tx_id) DO UPDATE SET review = EXCLUDED.review`,
    [userId, id, JSON.stringify(review)]
  );
}

// The whole review map for a user: { [txId]: review }.
async function allReviews(userId) {
  const { rows } = await db.query('SELECT tx_id, review FROM ai_reviews WHERE user_id = $1', [userId]);
  const map = {};
  for (const row of rows) map[row.tx_id] = row.review;
  return map;
}

/* ---------- spend tracking (Postgres, per user) ---------- */

const ZERO_USAGE = {
  totalReviews: 0, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
  webSearches: 0, functionCalls: 0, costUsd: 0,
};

async function loadUsage(userId) {
  const { rows } = await db.query('SELECT stats FROM ai_usage WHERE user_id = $1', [userId]);
  return rows.length ? { ...ZERO_USAGE, ...rows[0].stats } : { ...ZERO_USAGE };
}

function computeCostUsd({ inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, webSearches = 0 }) {
  return ((inputTokens - cachedInputTokens) * PRICE_INPUT
    + cachedInputTokens * PRICE_CACHED_INPUT
    + outputTokens * PRICE_OUTPUT) / 1e6
    + (webSearches * PRICE_WEB_SEARCH_PER_1K) / 1000;
}

function addUsage(total, response) {
  const u = response.usage || {};
  total.calls++;
  total.inputTokens += u.input_tokens || 0;
  total.cachedInputTokens += (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  total.outputTokens += u.output_tokens || 0;
  // Tool invocations are items in the response output. Requests carry
  // previous_response_id, so each response reports only its own new items and
  // nothing is counted twice across tool round-trips.
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') total.webSearches = (total.webSearches || 0) + 1;
    else if (item.type === 'function_call') total.functionCalls = (total.functionCalls || 0) + 1;
  }
}

// Atomically fold one review's token usage into the user's running totals.
// A row lock keeps concurrent sweep workers from losing each other's updates.
async function recordReviewUsage(userId, usage, { countsAsReview = true } = {}) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT stats FROM ai_usage WHERE user_id = $1 FOR UPDATE', [userId]);
    const stats = rows.length ? { ...ZERO_USAGE, ...rows[0].stats } : { ...ZERO_USAGE };
    if (countsAsReview) stats.totalReviews++;
    stats.calls += usage.calls;
    stats.inputTokens += usage.inputTokens;
    stats.cachedInputTokens += usage.cachedInputTokens;
    stats.outputTokens += usage.outputTokens;
    stats.webSearches += usage.webSearches || 0;
    stats.functionCalls += usage.functionCalls || 0;
    stats.costUsd += computeCostUsd(usage);
    await client.query(
      `INSERT INTO ai_usage (user_id, stats) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET stats = EXCLUDED.stats`,
      [userId, JSON.stringify(stats)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * What one review is expected to cost, for someone who has not run any yet.
 *
 * Setup has to put a number in front of a person deciding how many months to
 * review, and at that point there is no usage history to divide. These are the
 * measured averages from a real account rather than a calculation from the token
 * prices: about 1¢ per reviewed transaction, roughly a quarter of it tokens and
 * the rest the merchant search. The search does not run on every review —
 * familiar payees are recognised without one — so its share is a rate, which is
 * why the two halves are reported separately: with the search switched off, only
 * the token half applies.
 *
 * Settings → AI usage reports what actually happened, and is the number to
 * trust once there is one.
 */
const EST_TOKENS_USD_PER_REVIEW = Number(process.env.OPENAI_EST_TOKENS_PER_REVIEW) || 0.0025;
const EST_SEARCHES_PER_REVIEW = Number(process.env.OPENAI_EST_SEARCHES_PER_REVIEW) || 0.75;

const round4 = (n) => Math.round(n * 10000) / 10000;

function costBasis() {
  return {
    tokensPerReviewUsd: round4(EST_TOKENS_USD_PER_REVIEW),
    webSearchPerReviewUsd: round4(EST_SEARCHES_PER_REVIEW * PRICE_WEB_SEARCH_PER_1K / 1000),
  };
}

// The same estimate the setup page computes as you change the two settings,
// resolved server-side for one (transactions, webSearch) pair.
function estimateCost({ transactions = 0, webSearch = true } = {}) {
  const basis = costBasis();
  const perReviewUsd = round4(basis.tokensPerReviewUsd + (webSearch ? basis.webSearchPerReviewUsd : 0));
  return { transactions, perReviewUsd, totalUsd: Math.round(perReviewUsd * transactions * 100) / 100 };
}

async function usageSummary(userId) {
  const stats = await loadUsage(userId);
  return {
    ...stats,
    costUsd: Math.round(stats.costUsd * 10000) / 10000,
    avgPerReviewUsd: stats.totalReviews
      ? Math.round((stats.costUsd / stats.totalReviews) * 10000) / 10000
      : 0,
    model: MODEL,
    // costUsd already covers tokens and billable tool calls together. Splitting
    // the tool share back out invited reading the two as separate budgets when
    // what matters is the one number they add up to.
    prices: {
      inputPerMTok: PRICE_INPUT,
      cachedInputPerMTok: PRICE_CACHED_INPUT,
      outputPerMTok: PRICE_OUTPUT,
      webSearchPerKCalls: PRICE_WEB_SEARCH_PER_1K,
    },
    // What a review is expected to cost before the fact, so Settings can say
    // what turning the merchant search off would save.
    estimate: costBasis(),
  };
}

/* ---------- stats for the outlier judgement ---------- */

const round2 = (n) => Math.round(n * 100) / 100;

function amountStats(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    mean: round2(mean),
    std: round2(Math.sqrt(variance)),
    min: round2(Math.min(...values)),
    max: round2(Math.max(...values)),
  };
}

// Spend amounts (GBP, positive) grouped by category over the whole window.
function categoryStats(classified) {
  const byCategory = new Map();
  for (const item of classified) {
    if (item.tx.is_pending || item.kind !== 'spend') continue;
    if (item.effectiveBaseAmount === null || item.effectiveBaseAmount >= 0) continue;
    const cat = item.category || 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(-item.effectiveBaseAmount);
  }
  return [...byCategory.entries()]
    .map(([category, values]) => ({ category, ...amountStats(values) }))
    .sort((a, b) => b.count - a.count);
}

// Statement names vary per order ("Amazon* Nr3re5v44"), so an exact-name match
// reported "no other transactions with this merchant" for the very merchants
// the household uses most — directly contradicting the similar-transaction list
// printed right below it, and inviting false outlier calls. Use the same fuzzy
// merchant match the refund matcher trusts.
function merchantStats(classified, tx) {
  const name = String(tx.merchant || '').trim().toLowerCase();
  if (!name) return null;
  const values = [];
  let lastDate = null;
  for (const item of classified) {
    if (item.tx.id === tx.id || item.tx.is_pending) continue;
    if (merchantSimilarity(item.tx, tx) < 0.82) continue;
    if (typeof item.effectiveBaseAmount === 'number' && item.effectiveBaseAmount < 0) {
      values.push(-item.effectiveBaseAmount);
    }
    if (!lastDate || item.tx.date > lastDate) lastDate = item.tx.date;
  }
  const stats = amountStats(values);
  return stats ? { ...stats, lastDate } : null;
}

/* ---------- LLM-friendly rendering of transactions ---------- */

function formatTx(item, accountName) {
  const { tx } = item;
  const amount = `${tx.amount < 0 ? '' : '+'}${round2(tx.amount)} ${tx.currency}`;
  const base = tx.currency !== 'GBP' && typeof item.effectiveBaseAmount === 'number'
    ? ` (≈${round2(item.effectiveBaseAmount)} GBP)`
    : '';
  const desc = tx.description && tx.description !== tx.merchant ? ` — ${tx.description}` : '';
  const account = accountName.get(tx.account_id) || 'unknown account';
  return `${tx.date} | ${amount}${base} | ${tx.merchant || '(no merchant)'}${desc} | ${currentLabel(item)} | ${account}`;
}

// The (up to) 100 transactions preceding this one, oldest first.
function recentTransactions(classified, tx, accountName, limit = 100) {
  return classified
    .filter((item) => !item.tx.is_pending && item.tx.id !== tx.id && item.tx.date <= tx.date)
    .sort((a, b) => (a.tx.date < b.tx.date ? 1 : a.tx.date > b.tx.date ? -1 : 0))
    .slice(0, limit)
    .reverse()
    .map((item) => formatTx(item, accountName));
}

// Top matches by merchant-name similarity (edit distance), ties broken by
// date proximity — surfaces the same provider under statement-name variants,
// duplicates, and recurring payments the plain last-100 list can miss.
function similarTransactions(classified, tx, accountName, limit = 15) {
  const dayMs = 24 * 60 * 60 * 1000;
  const scored = [];
  for (const item of classified) {
    if (item.tx.id === tx.id || item.tx.is_pending) continue;
    const similarity = merchantSimilarity(item.tx, tx);
    if (similarity < 0.55) continue;
    const days = Math.abs(new Date(item.tx.date) - new Date(tx.date)) / dayMs;
    scored.push({ item, similarity, days });
  }
  scored.sort((a, b) => (b.similarity - a.similarity) || (a.days - b.days));
  return scored
    .slice(0, limit)
    .map(({ item, similarity }) => `${formatTx(item, accountName)} | name similarity ${similarity.toFixed(2)}`);
}

/* ---------- prompt ---------- */

function buildInstructions(categoryNames, { excludedNames = [], accountName = new Map(), webSearch = true } = {}) {
  const accounts = [...new Set(accountName.values())];
  const excludedNote = excludedNames.length
    ? `\n\nThese categories are not spending — they are held out of the spending totals: ${excludedNames.join(', ')}. Use them when they genuinely fit. A payment to or from a person the household also receives money from is usually an internal transfer, not a spending category — say so rather than forcing it into the nearest spending bucket.`
    : '';
  // Web search is the account's choice (Settings → AI review). With it off the
  // model has no search tool at all, so the prompt must not send it looking for
  // one — an unrecognisable payee becomes a low-confidence answer that says so,
  // and the scam check simply is not available.
  const searchNote = webSearch
    ? ' Use web search when the merchant is unfamiliar — find out what kind of business it is before deciding.'
    : ' You have no web access in this review: judge from the merchant name, the description and the surrounding transactions, and lower your confidence when the payee is one you cannot place.';
  const scamTask = webSearch
    ? ' a merchant that web search shows is widely reported as a scam or as fraudulent billing,'
    : '';
  const scamNote = webSearch
    ? ' When you search an unfamiliar merchant, notice what people say about it, not only what it sells; if the reports are of a scam, say so plainly in the outlier reason. Do not call something a scam on a single complaint — a business with ordinary bad reviews is not fraud.'
    : ' Without web access, judge suspicion from the numbers and the history alone — do not assert that a payee is a scam on the strength of its name.';
  return `You review the automatic classification of one personal-finance transaction for a household${accounts.length ? ` (accounts: ${accounts.join(', ')})` : ''}. Categories are assigned by case-insensitive keyword rules matched against merchant+description.

Available categories: ${categoryNames.join(', ')}. "Other" means unclassified.${excludedNote}

Pattern syntax for rules: a pattern is a case-insensitive substring of merchant+description; a "=" prefix means exact merchant or description match ("=railway"); spaces are significant ("pub " avoids matching "public").

Your tasks:
1. Judge the current classification. If it is "Other", pick the best category from the list (assessment "unclassified"). If it has a category, say whether it looks right ("correct") or should be a different category from the list ("wrong_category"). If the classification was set manually by the user, treat it as ground truth: assessment "correct", no alternative suggestion (you may still propose a rule and judge outlierness).${searchNote}
2. Propose a keyword rule ONLY if the current classification is wrong or "Other". If you judged it "correct", the existing rules already handle this merchant and another pattern for it is noise — return null. When you do propose one, propose ONE pattern and verify it with the preview_rule tool first: check the matches are consistent (they should all belong in the proposed category — the preview shows each match's current classification). If the pattern also catches transactions that clearly belong elsewhere, refine it or propose nothing. The pattern MUST match at least two transactions in the preview, this one included; a rule for a one-off merchant is noise, so return null instead. Prefer a distinctive substring of the merchant name. Do not propose rules for one-off transfers to individuals unless the payee recurs.
3. Say whether this transaction is an outlier worth a human look: an amount far outside the norm for this merchant or category (see the stats and the preceding transactions), a likely duplicate charge,${scamTask} or otherwise suspicious.${scamNote} The similar-transactions list (matched by merchant-name similarity) is the best evidence for duplicates and for what this provider usually charges — use it. Most transactions are NOT outliers.

A "Refund" classification means the transaction is money coming back that has already been matched to the purchase it reverses and subtracted from it. That is a statement about direction, not about which category the merchant belongs to — treat it as "correct" rather than reclassifying it into the category of the thing that was bought.

Be decisive and brief; reasoning should be one or two sentences, written in English.`;
}

function buildInput({ item, classified, accountName }) {
  const { tx } = item;
  const label = currentLabel(item);
  const catStats = categoryStats(classified)
    .map((s) => `- ${s.category}: n=${s.count}, mean=£${s.mean}, std=£${s.std}, min=£${s.min}, max=£${s.max}`)
    .join('\n');
  const mStats = merchantStats(classified, tx);
  const merchantLine = mStats
    ? `Previous transactions with this merchant: n=${mStats.count}, mean=£${mStats.mean}, std=£${mStats.std}, min=£${mStats.min}, max=£${mStats.max}, most recent ${mStats.lastDate}`
    : 'No other transactions with this merchant in the last 12 months.';
  const recent = recentTransactions(classified, tx, accountName);
  const similar = similarTransactions(classified, tx, accountName);

  return `Transaction to review:
- Date: ${tx.date}
- Merchant: ${tx.merchant || '(none)'}
- Description: ${tx.description || '(none)'}
- Amount: ${tx.amount < 0 ? '' : '+'}${round2(tx.amount)} ${tx.currency}${tx.currency !== 'GBP' && typeof item.effectiveBaseAmount === 'number' ? ` (≈${round2(item.effectiveBaseAmount)} GBP)` : ''} — money ${tx.amount < 0 ? 'out' : 'IN'}${item.returnOf ? `, already matched as a refund of the ${item.returnOf.date} purchase and netted against it` : ''}
- Account: ${accountName.get(tx.account_id) || 'unknown'}
- Current classification: ${label}${item.override || item.categoryOverride ? ' (set manually by the user)' : ' (from keyword rules)'}

${merchantLine}

Transactions with similar merchant names, most similar first (date | amount | merchant | classification | account):
${similar.join('\n') || '(none)'}

Per-category spend stats, last 12 months (amounts in GBP):
${catStats || '- (no data)'}

The ${recent.length} transactions preceding this one (oldest first; date | amount | merchant | classification | account):
${recent.join('\n') || '(none)'}`;
}

/* ---------- OpenAI Responses API plumbing ---------- */

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assessment: {
      type: 'string',
      enum: ['correct', 'wrong_category', 'unclassified'],
      description: '"unclassified" when the current category is Other; otherwise whether the current category is right',
    },
    suggested_category: {
      type: ['string', 'null'],
      description: 'Best category from the available list when assessment is not "correct"; null otherwise',
    },
    confidence: { type: 'number', description: '0–1 confidence in the category judgement' },
    reasoning: { type: 'string', description: 'One or two sentences' },
    proposed_rule: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            pattern: { type: 'string', description: 'The keyword pattern, verified with preview_rule' },
            category: { type: 'string', description: 'Category the pattern should map to' },
          },
          required: ['pattern', 'category'],
        },
      ],
    },
    is_outlier: { type: 'boolean' },
    outlier_reason: { type: ['string', 'null'] },
  },
  required: ['assessment', 'suggested_category', 'confidence', 'reasoning', 'proposed_rule', 'is_outlier', 'outlier_reason'],
};

function buildTools({ webSearch = true } = {}) {
  return [
    // Offered only when the account wants it: the model cannot search if the
    // tool is absent, which is the difference between a setting and a request.
    ...(webSearch ? [{ type: 'web_search' }] : []),
    {
      type: 'function',
      name: 'preview_rule',
      description: 'Dry-run a candidate keyword rule against the household\'s last 12 months of transactions. Returns how many transactions match, a breakdown by their CURRENT classification, and a sample. Use it to verify a rule only catches transactions that belong in the proposed category.',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Candidate pattern(s); same syntax as the rules (substring, "=" exact prefix, significant spaces)',
          },
        },
        required: ['patterns'],
      },
    },
  ];
}

const MAX_ATTEMPTS = 6;

function suggestedWaitMs(res, bodyText) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(bodyText || '');
  if (m) return parseFloat(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
  return 0;
}

async function callOpenAI(apiKey, body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err; // network hiccup: retryable
      lastErr.publicMessage = 'Could not reach OpenAI';
      res = null;
    }
    if (res) {
      if (res.ok) return res.json();
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ');
      lastErr = new Error(`OpenAI /responses -> ${res.status}: ${text.slice(0, 300)}`);
      lastErr.publicMessage = res.status === 429
        ? 'OpenAI rate limit hit — retry in a moment'
        : `OpenAI request failed (${res.status})`;
      if (res.status !== 429 && res.status < 500) throw lastErr; // not retryable
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.max(suggestedWaitMs(res, text), 1500 * 2 ** (attempt - 1))
          + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, Math.min(backoff, 45000)));
        continue;
      }
    } else if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// Concurrency is limited per OpenAI key, not globally: rate limits are billed
// and enforced per key, so one account's sweep must not throttle another's.
// Keyed by a hash rather than the key itself, so no plaintext credential ends
// up as a Map key that outlives the request.
const slotsByKey = new Map();

function slotsFor(apiKey) {
  const id = crypto.createHash('sha256').update(String(apiKey)).digest('hex');
  let state = slotsByKey.get(id);
  if (!state) slotsByKey.set(id, (state = { active: 0, waiters: [] }));
  return state;
}

// Without this a month view firing dozens of parallel reviews blows straight
// through that key's per-minute limits.
async function withModelSlot(apiKey, limit, fn) {
  const slots = slotsFor(apiKey);
  if (slots.active >= limit) await new Promise((resolve) => slots.waiters.push(resolve));
  slots.active++;
  try {
    return await fn();
  } finally {
    slots.active--;
    const next = slots.waiters.shift();
    if (next) next();
    // Drop the bucket once the key goes quiet, so rotated keys don't accumulate.
    if (!slots.active && !slots.waiters.length) {
      slotsByKey.delete(crypto.createHash('sha256').update(String(apiKey)).digest('hex'));
    }
  }
}

function outputText(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  return (response.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((m) => m.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

// Ask the model, executing preview_rule calls until it produces the final
// structured answer.
async function runModel({ apiKey, instructions, input, toolExec, webSearch = true }) {
  const base = {
    model: MODEL,
    instructions,
    tools: buildTools({ webSearch }),
    text: { format: { type: 'json_schema', name: 'transaction_review', strict: true, schema: RESPONSE_SCHEMA } },
  };
  if (/^(gpt-5|o\d)/.test(MODEL)) base.reasoning = { effort: REASONING_EFFORT };

  const usage = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, webSearches: 0, functionCalls: 0 };
  let response = await callOpenAI(apiKey, { ...base, input });
  addUsage(usage, response);
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const calls = (response.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      let result;
      try {
        result = await toolExec(call.name, JSON.parse(call.arguments || '{}'));
      } catch (err) {
        result = { error: err.message };
      }
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
    response = await callOpenAI(apiKey, { ...base, previous_response_id: response.id, input: outputs });
    addUsage(usage, response);
  }
  const text = outputText(response);
  try {
    return { parsed: JSON.parse(text), usage };
  } catch (_err) {
    throw new Error(`Model returned unparseable review: ${text.slice(0, 200)}`);
  }
}

/* ---------- onboarding: propose a category list ---------- */

// Names only, plus the two flags. Deliberately no patterns: a wrong category
// name costs a rename, a wrong pattern silently swallows real spending into the
// wrong total, so patterns stay with the per-row review where preview_rule
// checks each one against the actual transactions before it is applied.
const CATEGORY_SUGGESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    categories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Short display name, e.g. "Groceries"' },
          excludeFromSpending: {
            type: 'boolean',
            description: 'True when this is not spending: transfers between the owner\'s own accounts, investments, taxes',
          },
          tracker: {
            type: 'boolean',
            description: 'True to give this category its own chart and merchant breakdown on the dashboard',
          },
          autoTransfers: {
            type: 'boolean',
            description: 'True for the single category that should absorb automatically detected transfers between the owner\'s own accounts. Exactly one category must set this',
          },
          reason: { type: 'string', description: 'One short clause naming the evidence, e.g. "Freshmart, Dailygrocer"' },
        },
        required: ['name', 'excludeFromSpending', 'tracker', 'autoTransfers', 'reason'],
      },
    },
  },
  required: ['categories'],
};

const SUGGEST_INSTRUCTIONS = `You are setting up a personal finance dashboard for a new user. From a sample of the merchant names on their real accounts, propose the category list they should start with.

Rules:
- Propose 10 to 18 categories, ordered so that the most specific come first: matching is first-match-wins, so a narrow category must sit above a broad one that would also catch it.
- Name categories after what the user would recognise ("Groceries", "Eating out", "Transport"), not after individual merchants.
- Set excludeFromSpending on anything that is not consumption: transfers between the user's own accounts, investments and brokerage deposits, tax payments, mortgage capital. These leave the spending totals.
- Set tracker on the ones worth their own chart and merchant breakdown — typically investments, taxes, and any large recurring project you can see evidence for. A category can be a tracker and still count as spending.
- Exactly one category must set autoTransfers: the one that should absorb transfers detected between the user's own accounts. Name it something like "Internal transfers", and set excludeFromSpending on it too.
- Base every category on evidence in the sample. Do not invent a category for spending you cannot see. Give the evidence in "reason" as a couple of merchant names.
- Do not propose keyword patterns; only names and flags.`;

/**
 * One model call proposing a starting category list from the user's own merchant
 * names. Runs during onboarding, on the key the user has just supplied, and is
 * the only point where a broad look at their data is genuinely useful. Returns
 * the raw suggestions plus token usage; the caller decides what to keep.
 */
// Deterministic stand-in so onboarding is exercisable without a key or spend.
// `considered` follows the real sample size, since the setup page prints it
// ("suggested from your N most frequent payees") and a hardcoded 0 made that
// sentence read as a bug in mock mode.
function mockSuggestCategories(sampled = 0) {
  return {
    categories: [
      { name: 'Internal transfers', excludeFromSpending: true, tracker: false, autoTransfers: true, reason: 'mock' },
      { name: 'Investments', excludeFromSpending: true, tracker: true, autoTransfers: false, reason: 'mock' },
      { name: 'Taxes', excludeFromSpending: true, tracker: true, autoTransfers: false, reason: 'mock' },
      { name: 'Groceries', excludeFromSpending: false, tracker: false, autoTransfers: false, reason: 'mock' },
      { name: 'Eating out', excludeFromSpending: false, tracker: false, autoTransfers: false, reason: 'mock' },
      { name: 'Transport', excludeFromSpending: false, tracker: false, autoTransfers: false, reason: 'mock' },
      { name: 'Shopping', excludeFromSpending: false, tracker: false, autoTransfers: false, reason: 'mock' },
      { name: 'Bills & utilities', excludeFromSpending: false, tracker: false, autoTransfers: false, reason: 'mock' },
    ],
    usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, webSearches: 0, functionCalls: 0 },
    considered: sampled,
  };
}

const SUGGEST_SAMPLE = 300;

async function suggestCategories({ apiKey, merchants, currency = currencies.DEFAULT }) {
  const sample = (merchants || []).slice(0, SUGGEST_SAMPLE);
  if (useMockReviews()) return mockSuggestCategories(sample.length);
  const input = `Currency: ${currency}
Distinct merchant names seen on the user's accounts over the last 12 months`
    + ` (${sample.length} of ${merchants.length}), most frequent first:\n`
    + sample.map((m) => `- ${m}`).join('\n');

  const body = {
    model: MODEL,
    instructions: SUGGEST_INSTRUCTIONS,
    input,
    // One call, with nothing chained off it — so there is no reason for OpenAI
    // to keep the request, and a good reason not to: it is a list of the places
    // a household pays. The reviews do need `store` (they follow up with
    // previous_response_id), which is why this is set here rather than globally.
    store: false,
    text: { format: { type: 'json_schema', name: 'category_suggestions', strict: true, schema: CATEGORY_SUGGESTION_SCHEMA } },
  };
  if (/^(gpt-5|o\d)/.test(MODEL)) body.reasoning = { effort: REASONING_EFFORT };

  const usage = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, webSearches: 0, functionCalls: 0 };
  const response = await callOpenAI(apiKey, body);
  addUsage(usage, response);
  const text = outputText(response);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw new Error(`Model returned unparseable category suggestions: ${text.slice(0, 200)}`);
  }
  return {
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    usage,
    considered: sample.length, // what the model actually saw, not what exists
  };
}

/**
 * The same suggestion, once, on the instance's key instead of the user's.
 *
 * An account can be set up without an OpenAI key at all — the AI review is then
 * simply off — but that account still starts with no categories, and the one
 * thing that reads a whole year of somebody's merchant names to propose some is
 * a model call. This is the offer that fills that gap: one call, paid for by
 * whoever runs the instance, for people who have not decided whether they want
 * an OpenAI account yet.
 *
 * The key never leaves this module, and how often this may be called is not this
 * function's business — the caller claims the account's single use first (see
 * users.claimHostedSuggestion), because that has to be atomic against the
 * database, not against a promise in one process.
 */
async function suggestCategoriesOnHostKey({ merchants, currency } = {}) {
  const key = hostKey();
  if (!useMockReviews() && !key) {
    const err = new Error('ONBOARDING_OPENAI_KEY is not set');
    err.publicMessage = 'This instance cannot suggest categories for you — add your own OpenAI key instead';
    err.status = 503;
    throw err;
  }
  return suggestCategories({ apiKey: key, merchants, currency });
}

/* ---------- mock reviewer (MOCK_DATA mode, no API key) ---------- */

function mockReview({ item, classified, categoryNames }) {
  const { tx } = item;
  const label = currentLabel(item);
  const stats = merchantStats(classified, tx);
  const unclassified = label === 'Other';
  const wrongCategory = !unclassified && /ikea/i.test(tx.merchant || '') && label !== 'Home';
  const isOutlier = Boolean(stats && stats.count >= 3 && stats.std > 0 &&
    Math.abs(-tx.amount - stats.mean) > 3 * stats.std) || Math.abs(tx.amount) > 1000;
  const merchantWord = String(tx.merchant || '').toLowerCase().split(/\s+/)[0] || null;
  return {
    assessment: unclassified ? 'unclassified' : wrongCategory ? 'wrong_category' : 'correct',
    suggested_category: unclassified ? categoryNames[0] || null : wrongCategory ? 'Home' : null,
    confidence: 0.5,
    reasoning: 'Mock review (MOCK_DATA mode): deterministic placeholder for UI development.',
    proposed_rule: unclassified && merchantWord ? { pattern: merchantWord, category: categoryNames[0] } : null,
    is_outlier: isOutlier,
    outlier_reason: isOutlier ? 'Amount is unusual for this merchant (mock heuristic).' : null,
  };
}

/* ---------- public API ---------- */

function normalizeResult(parsed, item, context, categoryNames) {
  const categories = new Set([...categoryNames, 'Other']);
  const suggested = categories.has(parsed.suggested_category) ? parsed.suggested_category : null;
  let rule = parsed.proposed_rule &&
    typeof parsed.proposed_rule.pattern === 'string' && parsed.proposed_rule.pattern.trim() &&
    categories.has(parsed.proposed_rule.category)
    ? { pattern: parsed.proposed_rule.pattern, category: parsed.proposed_rule.category }
    : null;
  if (rule && context) {
    const preview = previewMatches(context.accounts, context.txs, [rule.pattern], context.overrides, 0, context.rulesDoc);
    const others = preview.count - (matchesAny(item.tx, [rule.pattern]) ? 1 : 0);
    if (others < 1) rule = null;
    else rule.matchCount = others;
  }
  const manualCategory = Boolean(item.categoryOverride);
  // A rule for a transaction the existing rules already classify correctly only
  // restates what they do: in a real sample four of five proposals duplicated a
  // rule that had already fired (Uber, amazon*, Indaba Yoga). Keep proposals for
  // the cases that need one — a wrong category, or no category at all.
  if ((manualCategory ? 'correct' : parsed.assessment) === 'correct') rule = null;
  return {
    txId: String(item.tx.id),
    at: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    model: useMockReviews() ? 'mock' : MODEL,
    reviewedCategory: currentLabel(item),
    assessment: manualCategory ? 'correct' : parsed.assessment,
    suggestedCategory: parsed.assessment === 'correct' || manualCategory ? null : suggested,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
    reasoning: String(parsed.reasoning || ''),
    proposedRule: rule,
    isOutlier: Boolean(parsed.is_outlier),
    outlierReason: parsed.is_outlier ? String(parsed.outlier_reason || '') : null,
  };
}

/**
 * Review one transaction for a user (cached unless force). Returns the review,
 * or null for an unknown transaction id. Concurrent requests for the same
 * (user, tx) share one OpenAI call.
 */
async function review(userId, txId, { force = false } = {}) {
  if (isForgotten(userId)) {
    const err = new Error('Account has been deleted');
    err.status = 401;
    throw err;
  }
  const id = String(txId);
  const inflight = inflightFor(userId);
  if (!force) {
    const existing = await getReview(userId, id);
    if (existing) return existing;
  }
  if (inflight.has(id)) return inflight.get(id);

  let apiKey = null;
  if (!useMockReviews()) {
    apiKey = (await users.getKeys(userId)).openai;
    if (!apiKey) {
      const err = new Error('OpenAI key is not set');
      err.publicMessage = 'AI review is not configured: add your OpenAI key in Settings';
      err.status = 503;
      throw err;
    }
  }

  const work = (async () => {
    const { accounts, txs } = await getConverted(userId, { preferCached: true });
    const ovr = await overrides.getAll(userId);
    const rulesDoc = await rules.get(userId);
    // Every category, including the ones excluded from spending. Withholding
    // them meant the reviewer had no way to say "internal transfer" or "taxes"
    // and had to force a payment to a person into a spending category — a £15k
    // transfer came back as "Family" at 0.42 confidence. Excluded categories are
    // labelled so the model knows they leave the spending totals.
    const categoryNames = rulesDoc.categories.map((c) => c.name);
    const excludedNames = rulesDoc.categories.filter((c) => c.excludeFromSpending).map((c) => c.name);
    const classified = classify(txs, ovr, rulesDoc);
    const item = classified.find((c) => String(c.tx.id) === id);
    if (!item) return null;
    const accountName = accountLabels(accounts, txs);

    let parsed;
    if (useMockReviews()) {
      parsed = mockReview({ item, classified, categoryNames });
    } else {
      const webSearch = rules.webSearchOf(rulesDoc);
      const outcome = await withModelSlot(apiKey, rules.concurrencyOf(rulesDoc), () => runModel({
        apiKey,
        webSearch,
        instructions: buildInstructions(categoryNames, { excludedNames, accountName, webSearch }),
        input: buildInput({ item, classified, accountName }),
        toolExec: (name, args) => {
          if (name !== 'preview_rule') throw new Error(`unknown tool ${name}`);
          // The model chooses these, and a rule preview costs
          // (patterns × transactions) on the one thread everyone shares. It only
          // ever needs one pattern, so a runaway argument is capped rather than
          // trusted.
          const asked = Array.isArray(args.patterns) ? args.patterns.slice(0, MAX_TOOL_PATTERNS) : [];
          const preview = previewMatches(accounts, txs, asked, ovr, 25, rulesDoc);
          return {
            matchCount: preview.count,
            byCurrentClassification: preview.byLabel,
            sample: preview.matches.map((m) => `${m.date} | ${m.amount} ${m.currency} | ${m.merchant} | ${m.label}`),
          };
        },
      }));
      parsed = outcome.parsed;
      await recordReviewUsage(userId, outcome.usage);
    }
    const result = normalizeResult(parsed, item, { accounts, txs, overrides: ovr, rulesDoc }, categoryNames);
    // A re-review must not resurface an outlier a human already looked at.
    const prev = await getReview(userId, id);
    if (prev && prev.outlierReviewed) result.outlierReviewed = true;
    await putReview(userId, id, result);
    return result;
  })().finally(() => inflight.delete(id));

  inflight.set(id, work);
  return work;
}

/**
 * Review the most recent unclassified ("Other") spend transactions for a user,
 * newest first. Cached results are reused unless force. Returns
 * { transactions, results }.
 */
async function reviewBatch(userId, { limit = 10, force = false } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 10, 20));
  const { accounts, txs } = await getConverted(userId, { preferCached: true });
  const accountName = accountLabels(accounts, txs);
  const targets = classify(txs, await overrides.getAll(userId), await rules.get(userId))
    .filter((item) => !item.tx.is_pending && item.kind === 'spend' &&
      item.tx.amount < 0 && (item.category || 'Other') === 'Other' && !item.returnOf)
    .sort((a, b) => (a.tx.date < b.tx.date ? 1 : a.tx.date > b.tx.date ? -1 : 0))
    .slice(0, cap);

  const results = {};
  for (const item of targets) {
    const id = String(item.tx.id);
    try {
      results[id] = await review(userId, id, { force });
    } catch (err) {
      console.error(`AI review of ${id} failed:`, err.message);
      results[id] = { error: err.publicMessage || 'AI review failed' };
      if (err.status === 503) break;
    }
  }
  return {
    transactions: targets.map((item) => ({
      id: String(item.tx.id),
      date: item.tx.date,
      merchant: item.tx.merchant || item.tx.description || '—',
      amount: round2(item.tx.amount),
      currency: item.tx.currency,
      account: accountName.get(item.tx.account_id) || '—',
      label: currentLabel(item),
    })),
    results,
  };
}

/* ---------- background sweep: review everything not yet cached ---------- */

function sweepStateFor(userId) {
  let s = sweepByUser.get(userId);
  if (!s) {
    sweepByUser.set(userId, (s = {
      running: false, total: 0, done: 0, failed: 0, startedAt: null, finishedAt: null,
    }));
  }
  return s;
}

/**
 * Drop every trace of a user from this process, for account deletion.
 *
 * A sweep is a detached Promise.all over a local queue, so deleting the rows
 * underneath it would leave it billing the (still decrypted) OpenAI key for
 * reviews it then fails to insert against a vanished user_id. The flag stops
 * the workers at their next iteration; the maps go so a re-registered account
 * on a fresh id never inherits stale progress.
 */
function forgetUser(userId) {
  forgottenUsers.add(userId);
  const state = sweepByUser.get(userId);
  if (state) state.cancelled = true;
  sweepByUser.delete(userId);
  inflightByUser.delete(userId);
}

const isForgotten = (userId) => forgottenUsers.has(userId);

/**
 * What the sweep will cover. `months` is the account's own setting (chosen
 * during setup, editable in Settings → AI review); `light` is a deployment-wide
 * development switch that reviews a handful of unclassified rows and stops.
 *
 * The resolved config is stashed on the sweep state so sweepStatus() can report
 * it without a database read on every progress poll — the client uses it to
 * decide which rows review themselves automatically, so it has to travel with
 * the status rather than be inferred.
 */
function sweepConfig(rulesDoc) {
  return {
    light: process.env.OPENAI_SWEEP_LIGHT === '1',
    months: rules.monthsOf(rulesDoc),
  };
}

function sweepStatus(userId) {
  const state = sweepStateFor(userId);
  return { ...state, config: state.config || sweepConfig(null) };
}

/**
 * Kick off (or report on) a background review of every eligible transaction for
 * a user that has no cached review yet. Runs the account's configured number of
 * reviews in parallel, and
 * returns the status snapshot immediately.
 */
async function sweep(userId) {
  if (isForgotten(userId)) return sweepStatus(userId);
  const sweepState = sweepStateFor(userId);
  if (sweepState.running) return sweepStatus(userId);
  if (!useMockReviews()) {
    const openai = (await users.getKeys(userId)).openai;
    if (!openai) {
      const err = new Error('OpenAI key is not set');
      err.publicMessage = 'AI review is not configured: add your OpenAI key in Settings';
      err.status = 503;
      throw err;
    }
  }

  const { txs } = await getConverted(userId, { preferCached: true });
  const rulesDoc = await rules.get(userId);
  const concurrency = rules.concurrencyOf(rulesDoc);
  const config = sweepConfig(rulesDoc);
  sweepState.config = config; // what the status endpoint and the client report
  let eligible = classify(txs, await overrides.getAll(userId), rulesDoc)
    .filter((item) => !item.tx.is_pending && item.kind === 'spend' && item.tx.amount < 0 && !item.returnOf)
    .sort((a, b) => (a.tx.date < b.tx.date ? 1 : a.tx.date > b.tx.date ? -1 : 0)); // newest first
  if (config.light) {
    eligible = eligible.filter((item) => (item.category || 'Other') === 'Other').slice(0, 10);
  } else {
    const from = new Date();
    from.setDate(1);
    from.setMonth(from.getMonth() - (config.months - 1));
    const cutoff = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
    eligible = eligible.filter((item) => item.tx.date.slice(0, 7) >= cutoff);
  }
  const existing = await allReviews(userId);
  const queue = eligible.map((item) => String(item.tx.id)).filter((id) => !existing[id]);

  sweepState.running = queue.length > 0;
  sweepState.total = queue.length;
  sweepState.done = 0;
  sweepState.failed = 0;
  sweepState.startedAt = new Date().toISOString();
  sweepState.finishedAt = queue.length ? null : new Date().toISOString();
  if (!queue.length) return sweepStatus(userId);

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !sweepState.cancelled && !isForgotten(userId)) {
      const id = queue.shift();
      try {
        await review(userId, id);
      } catch (err) {
        sweepState.failed++;
        console.error(`AI sweep: review of ${id} failed:`, err.message);
        if (err.status === 503) queue.length = 0;
      }
      sweepState.done++;
    }
  });
  Promise.all(workers).then(() => {
    sweepState.running = false;
    sweepState.finishedAt = new Date().toISOString();
    console.log(`AI sweep finished for user ${userId}: ${sweepState.done - sweepState.failed}/${sweepState.total} reviewed, ${sweepState.failed} failed`);
  });
  return sweepStatus(userId);
}

/* ---------- outlier inbox ---------- */

async function listOutliers(userId) {
  const { accounts, txs } = await getConverted(userId, { preferCached: true });
  const accountName = accountLabels(accounts, txs);
  const reviews = await allReviews(userId);
  const flaggedCount = Object.values(reviews).filter((r) => r.isOutlier).length;
  const entries = [];
  const rulesDoc = await rules.get(userId);
  for (const item of classify(txs, await overrides.getAll(userId), rulesDoc)) {
    const r = reviews[String(item.tx.id)];
    if (!r || !r.isOutlier || r.outlierReviewed || item.tx.is_pending) continue;
    entries.push({
      id: String(item.tx.id),
      date: item.tx.date,
      merchant: item.tx.merchant || item.tx.description || '—',
      amount: round2(item.tx.amount),
      currency: item.tx.currency,
      baseAmount: typeof item.effectiveBaseAmount === 'number' ? round2(item.effectiveBaseAmount) : null,
      account: accountName.get(item.tx.account_id) || '—',
      label: currentLabel(item),
      reason: r.outlierReason || '',
    });
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recent = entries.filter((e) => e.date >= weekCutoff).slice(0, 30);

  const groups = new Map();
  for (const e of entries) {
    const key = String(e.merchant).toLowerCase().split('*')[0].replace(/\s+/g, ' ').trim() || '—';
    if (!groups.has(key)) {
      groups.set(key, { name: String(e.merchant).split('*')[0].trim(), count: 0, total: 0, latest: e.date, outliers: [] });
    }
    const g = groups.get(key);
    g.count++;
    g.total = round2(g.total + Math.abs(e.baseAmount ?? e.amount));
    if (e.date > g.latest) g.latest = e.date;
    g.outliers.push(e);
  }
  const byMerchant = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, 30);

  return { recent, byMerchant, reviewedCount: Object.keys(reviews).length, flaggedCount };
}

// Mark an outlier as human-reviewed so it leaves the inbox. Returns false when
// there is no outlier review for that id.
async function ackOutlier(userId, txId) {
  const id = String(txId);
  const r = await getReview(userId, id);
  if (!r || !r.isOutlier) return false;
  if (!r.outlierReviewed) {
    r.outlierReviewed = true;
    await putReview(userId, id, r);
  }
  return true;
}

// Cached reviews for a list of ids — lets the UI paint known results without
// paying for any model calls.
async function cached(userId, ids) {
  if (!Array.isArray(ids) || !ids.length) return {};
  const { rows } = await db.query(
    'SELECT tx_id, review FROM ai_reviews WHERE user_id = $1 AND tx_id = ANY($2)',
    [userId, ids.map(String)]
  );
  const out = {};
  for (const row of rows) out[row.tx_id] = row.review;
  return out;
}

/* ---------- export / import ---------- */

async function exportData(userId) {
  return { reviews: await allReviews(userId), usage: await loadUsage(userId) };
}

async function importData(userId, { reviews, usage } = {}) {
  await db.query('DELETE FROM ai_reviews WHERE user_id = $1', [userId]);
  for (const [txId, review] of Object.entries(reviews || {})) {
    await db.query('INSERT INTO ai_reviews (user_id, tx_id, review) VALUES ($1, $2, $3)', [
      userId, String(txId), JSON.stringify(review),
    ]);
  }
  if (usage && typeof usage === 'object') {
    await db.query(
      `INSERT INTO ai_usage (user_id, stats) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET stats = EXCLUDED.stats`,
      [userId, JSON.stringify({ ...ZERO_USAGE, ...usage })]
    );
  }
}

module.exports = {
  review,
  suggestCategories,
  suggestCategoriesOnHostKey,
  hostedSuggestionAvailable,
  usesMockReviews: useMockReviews,
  recordUsage: recordReviewUsage,
  reviewBatch,
  sweep,
  sweepStatus,
  forgetUser,
  listOutliers,
  ackOutlier,
  usageSummary,
  costBasis,
  estimateCost,
  cached,
  exportData,
  importData,
  // exported for tests
  _internal: { amountStats, categoryStats, merchantStats, recentTransactions, similarTransactions, buildInput, buildInstructions, buildTools, normalizeResult, mockReview, computeCostUsd, addUsage, withModelSlot, RESPONSE_SCHEMA, PROMPT_VERSION,
    CATEGORY_SUGGESTION_SCHEMA, SUGGEST_INSTRUCTIONS,
    PRICE_WEB_SEARCH_PER_1K },
};

# Tallyhouse

Tallyhouse is a multi-user personal finance dashboard backed by the [Lunchflow](https://lunchflow.app) API.
Each user signs in with Google and brings their own Lunchflow + OpenAI keys; the app
aggregates their connected accounts and shows where the money went — monthly totals,
category breakdowns, and a section of its own for any category worth watching apart
from everyday spending. All state lives in Postgres, scoped per user. Nothing is
tracked, nothing is sold, and access to your bank is read-only.

## What it does

- **Sign in with Google** — any Google account can sign up, and the button says
  "Continue with Google" with a line under it saying that this *is* the sign-up:
  there is no separate registration, and "Sign in" reads as members-only to
  exactly the people who do not have an account yet. That page is also the pitch —
  what the app does, a sketch of the dashboard, and what setup will ask of you
  (two API keys, one of them paid) before you commit to anything. Sessions are
  cookie-based (stored in Postgres) and the sign-in endpoints are rate-limited.
  `/about`, `/privacy` and `/terms` are public pages.
- **Setup in three steps**, in the order the answers become knowable:
  1. **Connect** — the Lunchflow key (validated live, encrypted at rest with
     `ENCRYPTION_KEY`), plus an optional data export to seed the account from.
     Continuing pulls twelve months of accounts and transactions there and then; a
     key with no bank connected to it, or one whose first sync has not landed,
     stops setup with a sentence saying which of the two it is rather than handing
     over an empty dashboard that looks like a broken app.
  2. **AI review** — the OpenAI key, how many months back to review, whether the
     reviewer may look unfamiliar merchants up on the web, and a **cost estimate
     that follows both**, computed against the transactions step 1 just found.
     This is the point of the split: what the review costs is the one thing a new
     user cannot guess, and by now the app knows what it would be spread over.
  3. **Categories** — the list inferred from their own merchant names by a single
     model call, editable in place: rename, retick the flags, remove, add.

  The scan from step 1 is held in process for half an hour so neither later step
  re-pulls the bank. Each key field has a **?** that expands to say what the
  service is, what it costs, and the steps to get a key from it. Keys can be
  rotated later from **Settings → API keys**.
- **Capped signups with a waiting list** — the instance creates at most `MAX_USERS`
  accounts (default 20). The cap applies at first sign-in, never to an existing
  account, so nobody who already has data here can be locked out by it. Someone
  turned away lands back on the sign-in page with an explanation and a one-click
  **Join the waiting list**; the address is the one Google just verified, so
  `POST /api/waitlist` takes no input and cannot be used to enter anyone else's.
  Count-then-insert is serialized by an advisory lock, so two people arriving
  together cannot both take the last place. There is no mail transport, so the
  signal is the log: a line per new account, escalated to `WARN` at 80% of the cap
  and again when it is reached, plus one when someone joins the list.
  `GET /api/capacity` (signed in) returns `{ users, cap, waiting }`.
- **Monthly spending bar chart** — last 12 months across all accounts.
- **Category donuts** — this month vs the monthly average over the last 12 full
  months, with a full table below.
- **Trackers** — any category can carry the *tracker* flag to get its own tiles,
  chart and merchant breakdown, and *exclude from spending* to stay out of the
  spending totals and donuts. The two are independent, so investments, taxes or a
  building project each get their own section without any of them being built in.
- **Historical currency conversion** — each account picks the currency it keeps
  its books in (**Settings → Currency**, suggested during setup from whichever
  currency most of your transactions are in). Foreign transactions keep their
  original currency in transaction lists but are converted into that one for
  totals, using the ECB reference rate from the transaction date (or the latest
  preceding business day). The dropdown offers what the rate source can quote —
  `config/currencies.json`, which has to stay in step with `src/fx.js`. Number
  formatting is still `en-GB` throughout (`public/currency.js`), so a non-UK
  account gets its own currency with British thousands separators and date
  formats until locale follows currency.
- **Internal transfers ignored** — an outflow in one account matched by an equal
  inflow in another within 4 days is treated as a transfer between our own accounts
  and dropped, plus explicit description patterns.
- **Returns applied to their purchase** — an inflow is matched to the nearest
  earlier completed debit from the same merchant and currency that can cover it.
  The refund reduces spending in the purchase month instead of appearing as
  unrelated income in the return month.
- **Month drill-down + manual tagging** — click any bar in the monthly charts to
  list that month's transactions. Each row has one classification dropdown:
  pick any of your categories to pin it — transfer and tracker categories
  included, which is how a row gets marked an investment — or uncategorized
  **Spending**, or **Auto (rules)** to clear the override, or **Excluded from
  analytics** to drop the transaction from every chart and total (each row also has
  one-click **✕ exclude** / **↩ include** buttons). Overrides are keyed by
  transaction id and stored in Postgres, so they survive restarts and re-fetches
  (no extra Lunchflow calls to apply them). Rows inside the account's review
  window get their AI review computed automatically as the list opens; anything
  outside it has an on-demand **AI check** button.
  Click the **Date** or **Amount** column header to sort a list (amount sorts by the
  converted absolute value, largest first; click again to flip).

- **One flat category list** — every category carries its own keyword patterns
  plus two independent flags: *exclude from spending* (kept out of spending
  totals and the donuts — transfers, investments, taxes) and *tracker* (gets its
  own tiles, chart and merchant breakdown on the dashboard). They combine
  freely: tick both for something like Taxes, only the first for internal
  transfers, or only the second to spotlight a category that still counts in
  your spending. Precedence is list order, first match wins.
- **Editable classification rules** — Lunchflow's API returns raw transactions with
  **no category field**, so categories come from keyword rules. A new account starts
  with **no patterns at all**: a pattern names the individuals and small businesses
  you pay, so shipping a real set would publish one household's private life to
  everyone who installs this. [`config/settings.json`](config/settings.json)
  therefore holds only the one category the transfer detector needs. Rules are
  filled in two ways: the **Settings** page edits them by hand (add/rename/remove
  categories, one pattern per line, preview which transactions each rule matches),
  and the AI review on a transaction row proposes one pattern at a time, showing
  exactly what it would catch before you apply it. Edits are stored per user and
  win over the shipped defaults from then on. Matching is case-insensitive
  substring against merchant + description; a `=` prefix means exact match, and a
  trailing space means whole words only (`"pub "` matches neither `"public"` nor
  the `"pub"` inside another word).
- **AI classification review** — billed to each user's own OpenAI key, GPT reviews
  transactions one at a time: for an "Other" transaction it suggests a category (shown
  as a one-click **→ Category** button on the row); for a classified one it says whether
  the category looks right; it can propose a keyword rule (the **+ rule** button opens a
  modal where you edit the pattern and preview exactly which transactions it would match
  before applying); and it flags outliers (unusual amount for that merchant/category,
  likely duplicates), given per-category/merchant stats and the ~100 preceding
  transactions. It also gets a `preview_rule` tool, so it verifies a proposed rule
  against your real data before suggesting it. On page load the server starts a
  background sweep that reviews every uncached transaction in the account's window,
  in parallel (`OPENAI_CONCURRENCY`, default 2) — progress shows in the top bar and
  results appear on the rows as they land. Every result is cached in Postgres and is
  never recomputed automatically — not even when the prompt changes (reviews carry a
  prompt version, but only the ↻ button on a row forces a re-run). Human decisions always survive forced re-reviews: a dismissed
  outlier stays dismissed and a manually assigned category is treated as ground truth
  (never second-guessed). Flagged outliers collect in an **"Outliers to
  review"** inbox at the top of the dashboard; **Mark reviewed** dismisses one for good.
- **What the review costs is the account's choice** — **Settings → AI review**
  (and step 2 of setup) holds two settings, stored in the user's own rules
  document as `aiMonths` and `aiWebSearch`:
  - **how many months** the automatic sweep covers, so nobody is billed for a year
    of history they never asked for. Setup defaults new accounts to **1**;
    `OPENAI_SWEEP_MONTHS` is only the fallback for documents that say nothing.
  - **whether the reviewer may search the web** for merchants it does not
    recognise — what they sell, and whether they are widely reported as a scam,
    which is raised as an outlier rather than quietly categorised. Switched off,
    the model is handed **no search tool at all** and the prompt stops asking for
    one, so merchant names never reach a search engine.

  The search is roughly three quarters of the ~1¢ a review costs, so turning it
  off takes a review to about a quarter of a cent — which is why setup prices the
  two halves separately and the estimate moves as you touch the checkbox. Both
  screens show that estimate from the same server-side figures
  (`gpt.costBasis()`); **Settings → AI review spend** shows what has actually been
  spent, which is the number to trust once there is one.
- **Accepted suggestions become per-transaction category overrides** stored alongside
  the manual tags (a **✕ manual** button reverts to the rules).
- **Log out and delete your account** — the bottom of **Settings** ends with an
  **Account** card: who you are signed in as, a log out button, and a delete that
  opens a confirmation dialog. The dialog makes exporting a step rather than
  advice — the confirm field stays disabled until you have downloaded your data,
  and then wants `DELETE` typed. `POST /api/account/delete` removes the user row;
  every per-user table cascades off it. Sessions are deleted explicitly (that
  table has no foreign key, so a session on another device would otherwise
  outlive the account), and the shared `fx_rates` cache is deliberately kept. A
  running AI sweep is cancelled and the account is tombstoned in-process, so a
  sweep that starts while the delete is in flight can't bill a departed user's
  OpenAI key for reviews the foreign key then rejects.
- **Admin panel** (`/admin`, addresses in `ADMIN_EMAILS` only) — account counts,
  signups per month, a setup funnel with the drop between each step, sign-in
  volume and a per-account table. It **collects nothing**: every figure is a
  count or timestamp already in the database because the app needed it, which is
  the constraint that keeps the "no analytics, no tracking" promise on the
  privacy and About pages true. That rules some things out, and the panel says so
  on itself rather than approximating them — there is no page-view record, so no
  drop-*page* and no time-on-site, and *last activity* is not knowable either
  (`transactions_cache.cached_at` looks like it but the hourly sweep refreshes it
  for every onboarded account, so it measures the scheduler; last **sign-in** is
  real and that is what is shown). Adding any of it means recording behaviour and
  rewording both pages first — first-party and cookieless would still be
  analytics. `private/` holds the panel's HTML and script deliberately:
  `express.static` serves everything under `public/` to anyone who guesses a
  filename, and the panel lists every account's email.

## Environment variables

Lunchflow and OpenAI keys are **per-user** now — entered at onboarding, not via env.

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Railway's Postgres plugin injects it) |
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`) — encrypts each user's stored API keys |
| `SESSION_SECRET` | yes | Random string signing the session cookie |
| `GOOGLE_CLIENT_ID` | yes‡ | OAuth client id — enables "Sign in with Google" |
| `GOOGLE_CLIENT_SECRET` | yes‡ | OAuth client secret (pairs with the id) |
| `GOOGLE_REDIRECT_URI` | no | Override the callback URL; defaults to `<origin>/auth/google/callback` (must be registered on the OAuth client) |
| `MAX_USERS` | no | How many accounts this instance will create, default 20. Only refuses *new* sign-ins; existing accounts always get in. `0` means no limit |
| `ADMIN_EMAILS` | no | Comma-separated addresses that may open `/admin`. Unset means nobody, so the panel is off unless it is switched on deliberately. Everyone else gets a 404 from both the page and its API |
| `PGSSL` | no | `disable` to connect to a local Postgres without TLS (in production TLS is used with a relaxed chain) |
| `PG_POOL_MAX` | no | Maximum Postgres connections in the pool, default 10 |
| `LUNCHFLOW_BASE_URL` | no | Alternative Lunchflow API base URL |
| `PORT` | no | Provided by Railway; defaults to 3000 locally |
| `CACHE_TTL_MINUTES` | no | How long a Lunchflow pull counts as fresh, default 15 minutes |
| `STALE_SERVE_MINUTES` | no | How far past the TTL a cached pull is still served straight back while it refreshes behind the request, default 60 minutes. `0` makes every expired request wait for fresh data |
| `FX_API_URL` | no | Alternative endpoint compatible with Frankfurter's v2 rates API |
| `OPENAI_MODEL` | no | Model for reviews, default `gpt-5.4-mini` |
| `OPENAI_BASE_URL` | no | Alternative OpenAI-compatible endpoint |
| `OPENAI_REASONING_EFFORT` | no | `low` (default) / `medium` / `high` — low keeps reviews fast and cheap |
| `OPENAI_CONCURRENCY` | no | Default concurrent review calls per account, default 2. Each account can override it in **Settings → AI review** (1–10). The limit applies **per API key**, so one account's sweep never throttles another's; reviews are TPM-bound, so higher mostly buys 429s |
| `OPENAI_SWEEP_MONTHS` | no | Calendar months the sweep covers (current month counts), default 12. Only the **default**: setup asks each account (offering 1), and the answer is stored per user — this applies to accounts that have never chosen |
| `OPENAI_WEB_SEARCH` | no | `0` = accounts that have not chosen get the merchant web search **off**. Same rule as above: an account's own setting always wins |
| `OPENAI_SWEEP_LIGHT` | no | `1` = the sweep only covers the 10 most recent "Other" transactions — bounded cost for local testing |
| `OPENAI_PRICE_INPUT` / `OPENAI_PRICE_CACHED_INPUT` / `OPENAI_PRICE_OUTPUT` | no | USD per 1M tokens for the spend tracker, defaults 0.25 / 0.025 / 2.0 |
| `OPENAI_PRICE_WEB_SEARCH` | no | USD per 1000 web-search tool calls, default 10.0 — billed on top of the tokens the search generates |
| `OPENAI_EST_TOKENS_PER_REVIEW` / `OPENAI_EST_SEARCHES_PER_REVIEW` | no | What one review is *expected* to cost, for the estimate shown before any have run: USD of tokens (default 0.0025) and how often the merchant search fires (default 0.75, since familiar payees need no search). Measured averages, not a calculation from the token prices — override if your bill says otherwise |
| `LUNCHFLOW_DEBUG` | no | `1` = log account/transaction counts from each API call |
| `SWEEP_INTERVAL_MINUTES` | no | How often the background sweep reviews every onboarded account with nobody on the site, default 60. `0` disables it, leaving sweeps to start on page load. Requires a single replica |
| `MOCK_REVIEWS` | no | `1` = run the deterministic mock reviewer against real data — a staging copy exercises the AI flows without paying for reviews production already cached |
| `MOCK_DATA` | no | `1` = serve generated demo data; also skips key validation at onboarding and enables the passwordless dev email login when Google isn't configured |

‡ Google OAuth is required in production. Without it (local dev), a passwordless
email login stands in so the app is still usable.

### Setting up Google login

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials) create
   an **OAuth 2.0 Client ID** of type *Web application*.
2. Add your app's callback as an **Authorized redirect URI**:
   `https://your-domain/auth/google/callback` (and `http://localhost:3000/auth/google/callback`
   for local testing).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that client. No consent-screen
   scopes beyond `openid email` are needed. Anyone with a Google account can then sign up.

## Run locally

You need a Postgres to point `DATABASE_URL` at. The devcontainer includes one; the
app applies its schema automatically on boot.

```bash
npm install
createdb tallyhouse                                   # or: psql -c 'CREATE DATABASE tallyhouse'
export DATABASE_URL=postgresql://localhost:5432/tallyhouse
npm run dev          # demo data; sign in with the dev email login
```

`npm run dev` (and `npm run dev:live`) load `.env` if present — copy
`.env.example` to `.env` and fill it in (`DATABASE_URL`, `SESSION_SECRET`, and for
real Google login the OAuth vars). In `MOCK_DATA=1` dev mode the login page offers a
passwordless **email login**, onboarding **skips key validation** (enter anything),
and the AI review runs a deterministic mock — so the whole flow is exercisable offline.

To hit real services, sign in and enter your real Lunchflow + OpenAI keys at
onboarding (or run `npm run dev:live` without `MOCK_DATA`).

### Running the tests

```bash
npm test                                           # pure-logic tests only
TEST_DATABASE_URL=postgresql://localhost:5432/tallyhouse_test npm test   # + the Postgres-backed tests
```

The database-backed tests skip when `TEST_DATABASE_URL` isn't set. Point it at a
throwaway database — the tests create their own users and never touch your data.

### Maintenance scripts

Two standalone scripts, neither of which the app needs to run:

```bash
LUNCHFLOW_API_KEY=lf_... node scripts/debug-api.js   # what Lunchflow's API really returns
DATABASE_URL=postgres://...  node scripts/legacy-audit.js
```

`debug-api.js` prints the top-level keys and one sample record (never the key
itself), for when the API's shape changes under the parser. `legacy-audit.js` is
read-only and counts the old data shapes the code still carries read-time
support for, so that support can be deleted on evidence rather than on the
assumption that everything was migrated.

### Iterating on the AI review prompt without burning tokens

`POST /api/reviews/batch` with `{"limit":10,"force":true}` re-reviews just the 10
most recent "Other" transactions (hard-capped at 20 per call), even if cached —
handy after editing the prompt in [`src/gpt.js`](src/gpt.js). The automatic
background sweep never re-reviews anything cached, so it costs nothing on
subsequent page loads once it has been through the backlog.

## Deploy on Railway

The repo already includes `railway.json` (start command, `/healthz` healthcheck,
restart policy), so Railway needs no build config — just the env vars.

1. **Push to GitHub:**
   ```bash
   git push -u origin main
   ```
2. **Create the project:** at [railway.app](https://railway.app) → **New Project**
   → **Deploy from GitHub repo** → pick your fork. Railway detects Node and uses the
   start command from `railway.json` (`node server.js` — deliberately not `npm start`,
   so SIGTERM reaches Node itself on redeploys).
3. **Add Postgres:** in the project, **New → Database → Add PostgreSQL**. Railway
   injects `DATABASE_URL` into the app service automatically. The app creates its
   schema on first boot — no migration step.
4. **Set variables** (service → **Variables** → **Raw Editor**), then redeploy:
   ```
   ENCRYPTION_KEY=<paste output of: openssl rand -base64 32>
   SESSION_SECRET=<paste output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   GOOGLE_CLIENT_ID=<your OAuth client id>
   GOOGLE_CLIENT_SECRET=<your OAuth client secret>
   NODE_ENV=production
   ```
   `NODE_ENV=production` is required — it makes the session cookie `Secure` and
   enforces the auth/config checks. Don't set `PORT` or `DATABASE_URL`; Railway
   provides both.
5. **Get a URL:** service → **Settings → Networking → Generate Domain**. Open the
   HTTPS URL, sign in with Google, and enter your Lunchflow + OpenAI keys at onboarding.

Everything is persisted in Postgres, so data and logins survive deploys with no
volume to configure. Each user's transactions are cached for 15 minutes; the
**Refresh** button forces a re-fetch from Lunchflow, and stale data is served if
Lunchflow is temporarily unavailable.

### Moving an account between deployments

**Settings → Export all data** (or `GET /api/export`) downloads a
`tallyhouse-export-*.json`; signing in on the other deployment and choosing that file
under **Import a data export** at onboarding restores the rules, manual
classifications, AI reviews and cached transactions into that account.

## License

MIT — see [LICENSE](LICENSE).

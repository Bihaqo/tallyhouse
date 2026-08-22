'use strict';

// Setup, in three steps: connect the bank, decide what the AI review may do and
// what that will cost, then confirm the categories inferred from the data.
//
// Step 2 is skippable: an account with no OpenAI key simply has no AI review,
// and the rest of the app does not depend on it. That changes step 3, which
// would otherwise have nothing to propose — instead of a list, it offers to make
// one, on this instance's key rather than the user's, and waits to be asked.
//
// The order is not cosmetic. Step 1 pulls the user's transactions, and both of
// the steps after it are answers derived from that pull — the cost estimate
// needs to know how many transactions there are, and the category suggestion
// needs the merchant names. So the pull happens on "Continue" and a key that
// returns nothing stops setup there, where it can still be fixed, rather than
// landing someone on an empty dashboard with no way to tell an unconnected bank
// from a broken app.

const err = document.getElementById('err');
const form = document.getElementById('step-connect');

// Everything step 1 learned, carried forward rather than re-fetched.
const setup = {
  scan: null, // { accounts, transactions, merchants, currency, months[], cost }
  importData: null, // parsed export file, when one was chosen
  suggestions: [], // the proposed categories, as the model returned them
};

// Greet the user, and bounce to the dashboard if they've already onboarded.
fetch('/api/me')
  .then((res) => {
    if (res.status === 401) return (location.href = '/login'), null;
    return res.json();
  })
  .then((me) => {
    if (!me) return;
    if (me.onboarded) return (location.href = '/');
    if (me.email) document.getElementById('who').textContent = `, ${me.email}`;
  })
  .catch(() => {});

// Each "?" next to a field shows the panel named by its aria-controls. Kept
// collapsed by default so the form stays a short form for anyone who already
// has their keys.
document.querySelectorAll('.help-icon').forEach((btn) => {
  const panel = document.getElementById(btn.getAttribute('aria-controls'));
  if (!panel) return;
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    panel.hidden = open;
  });
});

const keys = () => ({
  lunchflow: document.getElementById('lunchflow').value.trim(),
  openai: document.getElementById('openai').value.trim(),
});

const STEPS = ['step-connect', 'step-ai', 'step-categories'];

function showStep(n) {
  err.textContent = '';
  STEPS.forEach((id, index) => {
    document.getElementById(id).hidden = index !== n - 1;
  });
  for (const dot of document.querySelectorAll('#setup-steps li')) {
    const step = Number(dot.dataset.step);
    dot.classList.toggle('is-current', step === n);
    dot.classList.toggle('is-done', step < n);
  }
  window.scrollTo(0, 0);
}

// Read the optional import file as parsed JSON (or null when none chosen).
function readImportFile() {
  const file = document.getElementById('import').files[0];
  if (!file) return Promise.resolve(null);
  return file.text().then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('The selected file is not valid JSON.');
    }
  });
}

// Send the keys and the AI settings, optionally with an import or an accepted
// category list. The currency rides along on every finish that isn't an import,
// including the skip, so choosing one and then skipping the categories still
// keeps it.
async function finish(body) {
  const select = document.getElementById('onboarding-currency');
  const currency = setup.importData ? '' : select.value;
  const res = await fetch('/api/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...keys(),
      ai: aiSettings(),
      ...(currency ? { currency } : {}),
      ...body,
    }),
  });
  if (res.status === 401) return (location.href = '/login');
  const parsed = await res.json().catch(() => ({}));
  if (res.ok) return (location.href = '/');
  // The instance filled up while this was being filled in. Everything typed is
  // already saved, so the only thing left to offer is the waiting list.
  if (parsed.full) document.getElementById('full-notice').hidden = false;
  throw new Error(parsed.error || 'Setup failed');
}

// Same endpoint and same one-click shape as the sign-in page's offer: it takes
// no input at all, because the address is the one Google verified.
document.getElementById('waitlist-join').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const status = document.getElementById('waitlist-status');
  button.disabled = true;
  status.textContent = '';
  try {
    const res = await fetch('/api/waitlist', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      status.textContent = `Thanks — ${body.email} is on the list. We will be in touch when a place opens up.`;
      button.hidden = true;
      return;
    }
    status.textContent = body.error || 'Could not add you to the list';
    button.disabled = false;
  } catch {
    status.textContent = 'Network error';
    button.disabled = false;
  }
});

/* ---------- step 1: connect ---------- */

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Reading your accounts…';
  try {
    setup.importData = await readImportFile();
    const res = await fetch('/api/onboarding/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lunchflow: keys().lunchflow }),
    });
    if (res.status === 401) return (location.href = '/login');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not read your accounts');
    setup.scan = body;
    showAiStep();
  } catch (ex) {
    err.textContent = ex.message || 'Network error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
});

/* ---------- step 2: the AI review, and what it will cost ---------- */

const months = () => {
  const value = Number(document.getElementById('ai-months').value);
  return Number.isFinite(value) ? Math.min(24, Math.max(1, Math.round(value))) : 1;
};
const webSearchOn = () => document.getElementById('ai-websearch').checked;
const hasOpenAiKey = () => Boolean(keys().openai);

// Sent even when the review is switched off, which is deliberate: they are the
// window an account gets the day someone adds a key in Settings, and one month
// chosen here is a far kinder starting point than the deployment-wide default
// (a year) landing on a first bill nobody expected.
const aiSettings = () => ({ months: months(), webSearch: webSearchOn() });

// Transactions the first review would cover, from the monthly counts the scan
// returned. Same window the server sweeps: whole calendar months, this one
// included, so "1 month" means the month you are in.
function inWindow(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (n - 1));
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return (setup.scan.months || [])
    .filter((m) => m.month >= cutoff)
    .reduce((total, m) => total + m.transactions, 0);
}

const cents = (usd) => `${(usd * 100).toFixed(usd * 100 < 1 ? 2 : 1)}¢`;

// The estimate, recomputed on every change to the two settings above it. It is
// the only number in setup that is about money the user will actually be
// charged, so it says what it is an estimate of and how it was arrived at.
function renderEstimate() {
  const box = document.getElementById('ai-estimate');
  box.textContent = '';
  const basis = setup.scan.cost || { tokensPerReviewUsd: 0, webSearchPerReviewUsd: 0 };
  const perReview = basis.tokensPerReviewUsd + (webSearchOn() ? basis.webSearchPerReviewUsd : 0);
  const n = inWindow(months());
  const line = (text, cls) => {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    el.textContent = text;
    box.appendChild(el);
  };

  // No key, no review, and therefore no bill — the one case where the estimate
  // is not a number. Said here rather than left blank, because a disabled form
  // with nothing under it reads as something being broken.
  if (!hasOpenAiKey()) {
    line('Nothing to pay — the AI review stays off', 'cost-estimate-head');
    line('Your transactions are never sent to a model. The dashboard, the rules and the '
      + 'classifications all work without it; add a key in Settings whenever you want the review, '
      + 'and these settings are what it will start from.', 'cost-estimate-note');
    return;
  }
  if (!n) {
    line('Nothing to review in that window yet.', 'cost-estimate-head');
    line('Reviews will start costing when new transactions arrive. Widen the window to review '
      + 'transactions you already have.', 'cost-estimate-note');
    return;
  }
  line(`About ${formatMoney(perReview * n, 'USD', 2)} to start`, 'cost-estimate-head');
  line(`Up to ${n.toLocaleString()} transaction${n === 1 ? '' : 's'} in the last `
    + `${months()} month${months() === 1 ? '' : 's'}, at roughly ${cents(perReview)} each`
    + `${webSearchOn() ? '' : ' with the web lookup off'}. Refunds and transfers between your own `
    + 'accounts are skipped, so the real figure lands under this.', 'cost-estimate-note');
  line('Charged by OpenAI to your own key, once — reviews are cached, and nothing is spent until '
    + 'you finish setup.', 'cost-estimate-note');
}

// Everything below the key describes the review, so with no key it is switched
// off rather than hidden: what is being turned down stays legible, and the
// values are still submitted for the day a key is added in Settings.
function syncAiOptions() {
  document.getElementById('ai-options').disabled = !hasOpenAiKey();
  renderEstimate();
}

function showAiStep() {
  const s = setup.scan;
  document.getElementById('scan-summary').textContent =
    `Found ${s.transactions.toLocaleString()} transactions across `
    + `${s.accounts} connected account${s.accounts === 1 ? '' : 's'}, from `
    + `${s.merchants.toLocaleString()} payees. Decide how much of that to review, and how.`;
  const next = document.getElementById('ai-continue');
  next.textContent = setup.importData ? 'Finish setup' : 'Continue';
  syncAiOptions();
  showStep(2);
}

for (const id of ['ai-months', 'ai-websearch']) {
  document.getElementById(id).addEventListener('input', renderEstimate);
}
document.getElementById('openai').addEventListener('input', syncAiOptions);

document.getElementById('ai-back').addEventListener('click', () => showStep(1));

document.getElementById('ai-continue').addEventListener('click', async (e) => {
  err.textContent = '';
  const btn = e.currentTarget;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    // An import brings its own rules, so there is nothing to suggest: the AI
    // settings are the last thing setup needs.
    if (setup.importData) {
      btn.textContent = 'Importing…';
      return await finish({ data: setup.importData });
    }
    // With no key of their own there is nothing to spend and nobody to bill, so
    // the suggestion is not made on the way through — the next step offers it
    // (on this instance's key) and waits to be asked.
    if (!hasOpenAiKey()) {
      return await showCategoriesStep({ currency: setup.scan.currency, categories: [] });
    }
    btn.textContent = 'Reading your spending…';
    const body = await suggestCategories(keys().openai);
    if (!body) return;
    await showCategoriesStep(body);
  } catch (ex) {
    err.textContent = ex.message || 'Network error';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/**
 * Ask the server to propose a category list. With `openai` it is that key and
 * that account's bill; without, the server runs its one hosted suggestion for
 * this account, which is why the button that calls it this way is a question.
 * Returns the body, or null when the page has already been sent to /login.
 */
async function suggestCategories(openai) {
  const res = await fetch('/api/onboarding/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lunchflow: keys().lunchflow, ...(openai ? { openai } : {}) }),
  });
  if (res.status === 401) {
    location.href = '/login';
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const ex = new Error(body.error || 'Could not suggest categories');
    ex.status = res.status;
    throw ex;
  }
  return body;
}

/* ---------- step 3: currency and the inferred categories ---------- */

/**
 * One editable row. The model proposes the buckets; the user is the one who
 * knows whether "Family" is spending or a standing arrangement with a relative,
 * so every part of a row can be changed and any row can be thrown away.
 *
 * `index` points back into the suggestion it came from, which is how a row keeps
 * the parts that are not on screen — the transfer flag, and the evidence the
 * model cited. A row the user adds has no index and no such baggage.
 */
function categoryRow(cat, index) {
  const row = document.createElement('div');
  row.className = 'suggest-row';
  if (index !== undefined) row.dataset.index = String(index);

  const head = document.createElement('div');
  head.className = 'suggest-head';
  const name = document.createElement('input');
  name.className = 'suggest-name';
  name.value = cat.name || '';
  name.placeholder = 'Category name';
  name.spellcheck = false;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'suggest-remove';
  remove.textContent = 'Remove';
  remove.title = 'Do not create this category';
  remove.addEventListener('click', () => row.remove());
  head.append(name, remove);

  const flags = document.createElement('div');
  flags.className = 'suggest-flags';
  for (const [key, label, title] of [
    ['excludeFromSpending', 'Not spending', 'Keep out of the spending totals — transfers, investments, taxes'],
    ['tracker', 'Show a chart', 'Give this category its own section on the dashboard'],
  ]) {
    const wrap = document.createElement('label');
    wrap.title = title;
    const flag = document.createElement('input');
    flag.type = 'checkbox';
    flag.className = `suggest-${key}`;
    flag.checked = Boolean(cat[key]);
    wrap.append(flag, document.createTextNode(' ' + label));
    flags.appendChild(wrap);
  }
  // Exactly one category absorbs the transfers the detector pairs up, and the
  // server enforces that, so it is stated here rather than offered as a box.
  // Remove the row it is on and the server puts the shipped one back.
  if (cat.autoTransfers) {
    const badge = document.createElement('span');
    badge.className = 'suggest-badge';
    badge.title = 'Transfers detected between your own accounts land here';
    badge.textContent = 'absorbs transfers';
    flags.appendChild(badge);
  }

  row.append(head, flags);
  if (cat.reason) {
    const meta = document.createElement('div');
    meta.className = 'suggest-meta';
    meta.textContent = cat.reason;
    row.appendChild(meta);
  }
  return row;
}

function renderSuggestions(list, note) {
  setup.suggestions = list;
  document.getElementById('suggest-note').textContent = note;
  const host = document.getElementById('suggest-list');
  host.textContent = '';
  list.forEach((cat, index) => host.appendChild(categoryRow(cat, index)));
}

document.getElementById('suggest-add').addEventListener('click', () => {
  const host = document.getElementById('suggest-list');
  host.appendChild(categoryRow({}));
  host.lastChild.querySelector('.suggest-name').focus();
});

// The DOM is the source of truth once it is on screen, so read the rows back
// rather than the list the model returned. A row with no name left in it is
// nothing to create, which is also what makes an empty added row harmless.
function chosenCategories() {
  return [...document.querySelectorAll('#suggest-list .suggest-row')]
    .map((row) => {
      const original = row.dataset.index === undefined
        ? {}
        : setup.suggestions[Number(row.dataset.index)] || {};
      return {
        ...original,
        name: row.querySelector('.suggest-name').value.trim(),
        excludeFromSpending: row.querySelector('.suggest-excludeFromSpending').checked,
        tracker: row.querySelector('.suggest-tracker').checked,
      };
    })
    .filter((cat) => cat.name);
}

/**
 * The currency their money is in, and the categories to start from.
 *
 * Shown even when nothing could be suggested, because the currency question
 * still has an answer worth asking for — it decides what every total on the
 * dashboard is denominated in, and getting it wrong is not obvious from the
 * numbers alone.
 */
async function showCategoriesStep(body) {
  const note = document.getElementById('currency-note');
  const explain = 'Your totals are shown in this currency, and anything you spend in another is '
    + 'converted into it at the rate on the day.';
  try {
    await fillCurrencySelect(document.getElementById('onboarding-currency'), body.currency);
    note.textContent = body.currency
      ? `${explain} Picked from your own transactions — change it if that's not right.`
      : `${explain} Nothing in your data said which to use, so pick yours.`;
  } catch (_err) {
    note.textContent = 'Could not load the currency list — you can set your currency in Settings '
      + 'once you are in.';
  }

  renderCategoryList(body);
  showStep(3);
}

/**
 * The suggestion list, the buttons under it, and — for an account with no OpenAI
 * key — the offer to fill it in on the instance's key. Called again after that
 * offer is taken, so this decides the whole state of the step from one body.
 */
function renderCategoryList(body) {
  const accept = document.getElementById('suggest-accept');
  const skip = document.getElementById('suggest-skip');
  const offer = document.getElementById('suggest-offer');
  // Only ever offered to someone who did not bring a key, only when the instance
  // has one to offer, and only until this account has had its one.
  offer.hidden = hasOpenAiKey() || !setup.scan.hostedSuggestion || Boolean(body.hosted);

  // Categories start with no patterns either way; what fills them in is not the
  // same thing, so the sentence that says so has to follow the key.
  document.getElementById('suggest-rules-note').textContent =
    'Remove anything you don\'t want, rename what is not quite right, and add any the suggestions '
    + 'missed. None of them have keyword rules yet: '
    + (hasOpenAiKey()
      ? 'the AI review proposes those one at a time as you go, showing what each would catch '
        + 'before it is applied.'
      : 'add those in Settings, where a preview shows exactly which transactions each one would '
        + 'catch before you save it.');

  if (body.categories && body.categories.length) {
    const total = body.merchantsTotal || body.merchantsConsidered;
    const scope = body.merchantsConsidered < total
      ? `your ${body.merchantsConsidered} most frequent payees, of ${total}`
      : `all ${total} of your payees`;
    renderSuggestions(body.categories, `Suggested from ${scope}.`
      + (body.hosted ? ' Run on Tallyhouse\'s key — nothing was charged to you.' : ''));
    accept.textContent = 'Create these and finish';
    skip.hidden = false;
  } else {
    // Nothing on the list yet, so there is nothing to skip past — but "add one"
    // is still an offer worth making, since a category typed here is a category
    // the dashboard can group by from the first day.
    renderSuggestions([], body.note
      || (offer.hidden
        ? 'Add the categories you want, or finish and set them up later in Settings.'
        : 'Add your own below, or have them suggested from your payees.'));
    accept.textContent = 'Finish setup';
    skip.hidden = true;
  }
}

// Take the offer: one suggestion, on the instance's key, for this account.
document.getElementById('suggest-run').addEventListener('click', async (e) => {
  err.textContent = '';
  const btn = e.currentTarget;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading your spending…';
  try {
    const body = await suggestCategories(null);
    if (!body) return;
    renderCategoryList(body);
  } catch (ex) {
    err.textContent = ex.message || 'Network error';
    // Already used, or this instance cannot run it: the button would only fail
    // again, so it goes rather than sitting there as a dead end.
    if (ex.status === 409 || ex.status === 503) {
      setup.scan.hostedSuggestion = false;
      document.getElementById('suggest-offer').hidden = true;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

document.getElementById('suggest-accept').addEventListener('click', async (e) => {
  err.textContent = '';
  const btn = e.currentTarget;
  const label = btn.textContent; // "Finish setup" when there was nothing to suggest
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    await finish({ categories: chosenCategories() });
  } catch (ex) {
    err.textContent = ex.message || 'Network error';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

document.getElementById('suggest-skip').addEventListener('click', async () => {
  err.textContent = '';
  try {
    await finish({ categories: [] });
  } catch (ex) {
    err.textContent = ex.message || 'Network error';
  }
});

// Ending the session is what makes /login reachable again: it redirects anyone
// still signed in to /, which sends a half-onboarded account back to this page.
document.getElementById('switch-account').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_err) { /* go to the login page regardless — it will ask again */ }
  location.href = '/login';
});

showStep(1);

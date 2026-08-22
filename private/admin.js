'use strict';

// The admin panel's rendering. Everything it draws comes from one call to
// /api/admin/stats; see src/admin.js for what is and isn't knowable.

const $ = (id) => document.getElementById(id);

const nf = new Intl.NumberFormat('en-GB');
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

function date(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

// "3 days ago" reads faster than a date when the question is "recently?".
function ago(value) {
  if (!value) return '—';
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return date(value);
}

function tile(label, value, sub) {
  const el = document.createElement('div');
  el.className = 'tile';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  el.append(l, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    el.appendChild(s);
  }
  return el;
}

function renderTiles(data) {
  const { totals, waitlist } = data;
  const converted = totals.total ? Math.round((totals.onboarded / totals.total) * 100) : 0;
  $('tiles').replaceChildren(
    tile('Accounts', nf.format(totals.total), `${nf.format(totals.onboarded)} finished setup · ${converted}%`),
    tile('New this week', nf.format(totals.new7d), 'last 7 days'),
    tile('New this month', nf.format(totals.new30d), 'last 30 days'),
    tile('Waiting list', nf.format(waitlist.total),
      waitlist.latest ? `latest ${ago(waitlist.latest)}` : 'nobody turned away')
  );
}

function renderUse(data) {
  const e = data.engagement;
  $('use-tiles').replaceChildren(
    tile('Sign-ins', nf.format(e.signIns30d), `last 30 days · ${nf.format(e.signIns7d)} this week`),
    tile('Accounts signing in', nf.format(e.accountsSeen30d), 'distinct, last 30 days'),
    tile('Manual classifications', nf.format(e.overrides),
      `${nf.format(e.accountsClassifying)} accounts · only a person makes these`),
    tile('AI reviews', nf.format(e.reviews), `${usd(e.costUsd)} billed to users' own keys`)
  );
}

// A horizontal bar per step, each as a share of the first, so the drop between
// steps is the thing the eye lands on.
function renderFunnel(steps) {
  const top = steps.length ? steps[0].count : 0;
  const host = $('funnel');
  host.replaceChildren();
  steps.forEach((entry, i) => {
    const previous = i ? steps[i - 1].count : null;
    const lost = previous === null ? null : previous - entry.count;

    const row = document.createElement('div');
    row.className = 'funnel-row';

    const head = document.createElement('div');
    head.className = 'funnel-head';
    const name = document.createElement('span');
    name.className = 'funnel-step';
    name.textContent = entry.step;
    const count = document.createElement('span');
    count.className = 'funnel-count';
    count.textContent = top
      ? `${nf.format(entry.count)} · ${Math.round((entry.count / top) * 100)}%`
      : nf.format(entry.count);
    head.append(name, count);

    const track = document.createElement('div');
    track.className = 'funnel-track';
    const fill = document.createElement('div');
    fill.className = 'funnel-fill';
    fill.style.width = `${top ? (entry.count / top) * 100 : 0}%`;
    track.appendChild(fill);

    const note = document.createElement('div');
    note.className = 'funnel-note';
    note.textContent = lost
      ? `${entry.note} — ${nf.format(lost)} did not get this far`
      : entry.note;

    row.append(head, track, note);
    host.appendChild(row);
  });
}

function renderSignups(months) {
  const peak = Math.max(1, ...months.map((m) => m.signups));
  const host = $('signups');
  host.replaceChildren();
  const chart = document.createElement('div');
  chart.className = 'signup-chart';
  for (const month of months) {
    const col = document.createElement('div');
    col.className = 'signup-col';
    col.title = `${month.month}: ${month.signups}`;
    const n = document.createElement('span');
    n.className = 'signup-n';
    n.textContent = month.signups || '';
    // The bar is sized against the track rather than the column, so a full-height
    // month cannot push its own label off the bottom of the chart.
    const track = document.createElement('div');
    track.className = 'signup-track';
    const bar = document.createElement('div');
    bar.className = 'signup-bar';
    bar.style.height = `${(month.signups / peak) * 100}%`;
    // A month nobody signed up in draws nothing; the class's min-height is there
    // to keep a small non-zero month visible, not to invent a sliver for zero.
    if (!month.signups) bar.style.minHeight = '0';
    track.appendChild(bar);
    const label = document.createElement('span');
    label.className = 'signup-label';
    label.textContent = month.month.slice(2); // "26-08"
    col.append(n, track, label);
    chart.appendChild(col);
  }
  host.appendChild(chart);
}

// One decimal, because these are averages over a handful of accounts and
// rounding "1.5 banks" to 2 would invent a precision the number does not have.
const num = (n) => (Number.isInteger(n) ? nf.format(n) : Number(n).toFixed(1));
const measure = (value, unit) => (unit === 'usd' ? usd(value) : num(value));

function renderPerAccount(data) {
  const { accounts, withOpenai, withOverrides, activeWeek, activeMonth, metrics } = data;

  $('per-account-tiles').replaceChildren(
    tile('Set-up accounts', nf.format(accounts), 'everything below is over these'),
    tile('Signed in recently', nf.format(activeWeek),
      `this week · ${nf.format(activeMonth)} in the last 30 days`),
    tile('Running the AI review', nf.format(withOpenai), 'gave an OpenAI key of their own'),
    tile('Classifying by hand', nf.format(withOverrides), 'have corrected at least one')
  );

  const body = $('per-account').querySelector('tbody');
  body.replaceChildren();
  if (!accounts) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 3;
    cell.textContent = 'Nobody has finished setup yet, so there is nothing to average.';
    cell.className = 'admin-muted';
    return;
  }
  for (const row of metrics) {
    const tr = body.insertRow();
    const head = tr.insertCell();
    head.textContent = row.metric;
    const note = document.createElement('div');
    note.className = 'admin-muted';
    note.textContent = row.note;
    head.appendChild(note);

    for (const value of [row.median, row.average]) {
      const cell = tr.insertCell();
      cell.className = 'col-amount';
      cell.textContent = measure(value, row.unit);
    }
  }
}

/**
 * The messages people sent.
 *
 * Built with textContent throughout: this is the one thing on the page written
 * by a person rather than counted by a query, so it is the one place where
 * assembling HTML from a string would hand somebody an injection into the
 * operator's own panel.
 */
function renderFeedback(rows) {
  const host = $('feedback-list');
  host.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'admin-muted';
    empty.textContent = 'Nothing yet.';
    host.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement('article');
    item.className = 'feedback-item';

    const head = document.createElement('div');
    head.className = 'feedback-head';
    const who = document.createElement('strong');
    who.textContent = row.fromDemo ? 'From the demo' : row.email || 'Account since deleted';
    const when = document.createElement('span');
    when.className = 'admin-muted';
    when.textContent = `${ago(row.createdAt)}${row.page ? ` · ${row.page}` : ''}`;
    head.append(who, when);

    const body = document.createElement('p');
    body.className = 'feedback-message';
    body.textContent = row.message;

    item.append(head, body);

    if (row.hasScreenshot) {
      // Loaded on click, not on render: a page of messages should not pull
      // every attached picture of somebody's balances into the browser because
      // the operator opened the panel to read a count.
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `Show the attached picture (${Math.round((row.screenshotBytes || 0) / 1024)} KB)`;
      const img = document.createElement('img');
      img.className = 'feedback-shot';
      img.alt = 'The picture attached to this message';
      details.addEventListener('toggle', () => {
        if (details.open && !img.src) img.src = `/api/admin/feedback/${row.id}/screenshot`;
      });
      details.append(summary, img);
      item.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    const delStatus = document.createElement('span');
    delStatus.className = 'admin-muted';
    del.addEventListener('click', async () => {
      del.disabled = true;
      delStatus.textContent = 'Deleting…';
      try {
        const res = await fetch(`/api/admin/feedback/${row.id}`, { method: 'DELETE' });
        if (res.ok) return void item.remove();
        delStatus.textContent = 'Could not delete that one';
        del.disabled = false;
      } catch {
        delStatus.textContent = 'Network error';
        del.disabled = false;
      }
    });
    actions.append(del, delStatus);
    item.appendChild(actions);

    host.appendChild(item);
  }
}

async function loadFeedback() {
  try {
    const res = await fetch('/api/admin/feedback');
    if (!res.ok) throw new Error(`Could not load feedback (${res.status})`);
    renderFeedback((await res.json()).feedback || []);
  } catch (err) {
    // The statistics above are still worth showing if this one call fails.
    $('feedback-list').textContent = err.message || 'Could not load feedback';
  }
}

async function load() {
  const res = await fetch('/api/admin/stats');
  if (res.status === 401) return void (location.href = '/login');
  if (!res.ok) throw new Error(`Could not load statistics (${res.status})`);
  const data = await res.json();

  renderTiles(data);
  renderFunnel(data.funnel);
  renderSignups(data.signups);
  renderUse(data);
  renderPerAccount(data.perAccount);
  await loadFeedback();
  $('generated').textContent = `Read from the database at ${new Date(data.generatedAt)
    .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Nothing here is tracked — it is all counted on request.`;
}

load().catch((err) => {
  $('err').textContent = err.message || 'Network error';
});

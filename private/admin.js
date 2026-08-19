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

function renderAccounts(rows) {
  const body = $('accounts').querySelector('tbody');
  body.replaceChildren();
  for (const row of rows) {
    const tr = body.insertRow();
    tr.insertCell().textContent = row.email;
    tr.insertCell().textContent = date(row.createdAt);

    const setup = tr.insertCell();
    setup.textContent = row.onboardedAt ? date(row.onboardedAt) : 'unfinished';
    if (!row.onboardedAt) setup.className = 'admin-muted';

    tr.insertCell().textContent = ago(row.lastSignIn);

    const number = (text) => {
      const cell = tr.insertCell();
      cell.className = 'col-amount';
      cell.textContent = text;
    };
    for (const value of [row.signIns30d, row.bankAccounts, row.categories, row.overrides, row.reviews]) {
      number(nf.format(value || 0));
    }
    number(usd(row.costUsd));
  }
  if (!rows.length) {
    const tr = body.insertRow();
    const cell = tr.insertCell();
    cell.colSpan = 10;
    cell.textContent = 'No accounts yet.';
    cell.className = 'admin-muted';
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
  renderAccounts(data.accounts);
  $('generated').textContent = `Read from the database at ${new Date(data.generatedAt)
    .toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Nothing here is tracked — it is all counted on request.`;
}

load().catch((err) => {
  $('err').textContent = err.message || 'Network error';
});

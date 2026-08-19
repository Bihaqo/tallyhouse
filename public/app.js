'use strict';

/* global Chart */

const $ = (id) => document.getElementById(id);
let charts = [];
let summary = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme() {
  return {
    surface: cssVar('--surface'),
    grid: cssVar('--grid'),
    baseline: cssVar('--baseline'),
    muted: cssVar('--text-muted'),
    secondary: cssVar('--text-secondary'),
    primary: cssVar('--text-primary'),
    accent: cssVar('--accent'),
    accentFaded: cssVar('--accent') + '55',
    invest: cssVar('--accent-invest'),
    renovation: cssVar('--accent-renovation'),
    tax: cssVar('--accent-tax'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`)),
    other: cssVar('--other'),
  };
}

// An amount in the account's own currency — every total on the dashboard is
// converted into it, so the code comes from the summary rather than the row.
const money = (n, dp = 0) => formatMoney(n, summary?.currency, dp);

// Rough age of the data, so "as of 19:31" is readable at a glance without
// working out how long ago that was. Under a couple of minutes reads as current.
function describeAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Categories kept out of the donuts, from each account's own "exclude from
// chart" setting. This used to be a hard-coded `['Car']` — one household's
// preference applied to everybody's dashboard, and the same leftover that was
// taken out of the rules migration for the same reason. Reading the flag also
// makes the settings checkbox do what it says: before this it only moved the
// spending line, and the donuts ignored it.
const chartExcluded = () => new Set(summary?.chartExcluded || []);

// One transaction, in the currency it was actually charged in — which is not
// necessarily the account's, hence the explicit code.
const transactionMoney = (n, currency, dp = 2) => formatMoney(n, currency, dp);

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short', year: '2-digit' });
}

/* ---------- category colors: fixed per entity, max 8 + Other ---------- */

function categoryColorMap() {
  const t = theme();
  const order = [];
  for (const c of summary.categoriesYearAvg) order.push(c.category);
  for (const c of summary.categoriesThisMonth) {
    if (!order.includes(c.category)) order.push(c.category);
  }
  const named = order.filter((c) => c !== 'Other');
  const map = new Map();
  named.forEach((c, i) => map.set(c, t.series[i % t.series.length]));
  const folded = new Set();
  map.set('Other', t.other);
  return { map, folded };
}

function foldCats(list, folded) {
  const out = new Map();
  for (const { category, amount } of list) {
    const key = folded.has(category) ? 'Other' : category;
    out.set(key, (out.get(key) || 0) + amount);
  }
  return [...out.entries()].map(([category, amount]) => ({ category, amount }));
}

/* ---------- charts ---------- */

function baseScales(t) {
  return {
    x: {
      grid: { display: false },
      border: { color: t.baseline },
      ticks: { color: t.muted },
    },
    y: {
      beginAtZero: true,
      grid: { color: t.grid, drawTicks: false },
      border: { display: false },
      ticks: { color: t.muted, maxTicksLimit: 6, callback: (v) => money(v) },
    },
  };
}

function tooltipStyle(t) {
  return {
    backgroundColor: t.primary,
    titleColor: t.surface,
    bodyColor: t.surface,
    padding: 10,
    cornerRadius: 8,
    displayColors: false,
  };
}

function makeBarChart(canvas, labels, values, { color, fadedLast = false, name, lastIsPartial = false }) {
  const t = theme();
  const colors = values.map((_, i) =>
    fadedLast && i === values.length - 1 ? t.accentFaded : color
  );
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: name,
          data: values,
          backgroundColor: colors,
          maxBarThickness: 24,
          borderRadius: 4, // rounded data-end; base stays square via default borderSkipped
          categoryPercentage: 0.72,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, els) => {
        if (els.length) go(`#/month/${encodeURIComponent(summary.months[els[0].index].month)}`);
      },
      onHover: (evt, els) => {
        evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false }, // single series: the card title names it
        tooltip: {
          ...tooltipStyle(t),
          callbacks: {
            label: (ctx) => `${name}: ${money(ctx.parsed.y, 2)}`,
            afterLabel: (ctx) =>
              lastIsPartial && ctx.dataIndex === values.length - 1 ? 'month still in progress' : undefined,
          },
        },
      },
      scales: baseScales(t),
    },
  });
}

function makeDonut(canvas, cats, colorMap, onSlice) {
  const t = theme();
  const total = cats.reduce((s, c) => s + c.amount, 0);
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: cats.map((c) => c.category),
      datasets: [
        {
          data: cats.map((c) => c.amount),
          backgroundColor: cats.map((c) => colorMap.get(c.category) || t.other),
          borderColor: t.surface, // the 2px surface gap between segments
          borderWidth: 2,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      onClick: onSlice ? (_e, els) => els.length && onSlice(cats[els[0].index].category) : undefined,
      onHover: onSlice
        ? (evt, els) => (evt.native.target.style.cursor = els.length ? 'pointer' : 'default')
        : undefined,
      plugins: {
        legend: { display: false }, // one shared HTML legend + table below
        tooltip: {
          ...tooltipStyle(t),
          callbacks: {
            label: (ctx) => {
              const pct = total ? Math.round((ctx.parsed / total) * 100) : 0;
              return `${money(ctx.parsed, 2)} · ${pct}%`;
            },
          },
        },
      },
    },
  });
}

/* ---------- DOM sections ---------- */

function renderTiles() {
  const { totals } = summary;
  const partial = summary.partialMonth || {};
  // Say how much of the month has actually happened: an 8-day total sitting next
  // to a full-month average reads as a collapse in spending (or a blowout).
  const soFar = partial.daysElapsed
    ? `first ${partial.daysElapsed} of ${partial.daysInMonth} days`
    : 'so far this month';
  const tiles = [
    ['Spent this month', money(totals.spendThisMonth), soFar],
    ['Average monthly spend', money(totals.avgMonthlySpend), 'last 12 full months'],
  ];
  if (totals.avgMonthlyIncome) {
    tiles.push(['Average monthly income', money(totals.avgMonthlyIncome), 'last 12 full months']);
    tiles.push([
      'Average monthly net',
      money(totals.avgMonthlyNet),
      totals.avgMonthlyNet >= 0 ? 'kept, on average' : 'shortfall, on average',
    ]);
  }
  for (const tracker of summary.trackers) {
    // A tracker can still count as spending; only say it is held out when it is.
    tiles.push([
      `${tracker.name} this month`,
      money(tracker.thisMonth),
      tracker.excludeFromSpending ? 'excluded from normal spending' : 'also counted in spending',
    ]);
    tiles.push([`${tracker.name} last 12 months`, money(tracker.total12m), 'tracked separately']);
  }
  const el = $('tiles');
  el.textContent = '';
  for (const [label, value, sub] of tiles) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    for (const [cls, text] of [['label', label], ['value', value], ['sub', sub]]) {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      tile.appendChild(d);
    }
    el.appendChild(tile);
  }
}

// Describe the monthly chart from the live category flags. The old text was a
// hardcoded list that claimed investments and renovation were excluded whatever
// the settings actually said.
function renderMonthlySub() {
  const held = (summary.hiddenFromSpending || []).map((h) => h.name.toLowerCase());
  const offChart = (summary.categoriesOffChart || []).map((c) => c.toLowerCase());
  const bits = ['Last 12 months, all accounts'];
  if (held.length) bits.push(`${held.join(', ')} excluded`);
  if (offChart.length) bits.push(`${offChart.join(', ')} kept out of the bars but still in the totals`);
  $('monthly-sub').textContent =
    `${bits.join(' — ')}. The last bar is the month so far. Click a month to see its transactions.`;
}

// Income against spending, and the gap between them. Everything here used to be
// discarded, so there was no way to see earnings or what was actually kept.
function renderIncome(labels, t) {
  const card = $('income-card');
  const months = summary.months || [];
  const hasIncome = months.some((m) => m.income > 0);
  card.hidden = !hasIncome;
  if (!hasIncome) return;

  const partial = summary.partialMonth || {};
  $('income-sub').textContent =
    'Money in, money out and what is left, per month. Income excludes transfers between your own '
    + 'accounts. The last month is still in progress.';

  charts.push(new Chart($('income-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income', data: months.map((m) => m.income), backgroundColor: t.income || cssVar('--accent-invest'), maxBarThickness: 18, borderRadius: 4 },
        { label: 'Spending', data: months.map((m) => m.spend), backgroundColor: t.accent, maxBarThickness: 18, borderRadius: 4 },
        { label: 'Net', type: 'line', data: months.map((m) => m.net), borderColor: cssVar('--text-secondary'), backgroundColor: 'transparent', borderWidth: 2, pointRadius: 2, tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_e, els) => { if (els.length) go(`#/month/${encodeURIComponent(months[els[0].index].month)}`); },
      plugins: {
        legend: { display: true, labels: { color: cssVar('--text-secondary'), boxWidth: 10, usePointStyle: true } },
        tooltip: {
          ...tooltipStyle(t),
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${money(ctx.parsed.y, 2)}`,
            afterLabel: (ctx) =>
              partial.daysElapsed && ctx.dataIndex === months.length - 1 ? 'month still in progress' : undefined,
          },
        },
      },
      scales: baseScales(t),
    },
  }));

  const rows = (summary.incomeByPayer || []).slice(0, 12);
  const table = $('income-table');
  table.textContent = '';
  const head = table.insertRow();
  for (const h of ['Where it came from', 'Last 12 months', 'Monthly average']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  for (const r of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = r.name;
    tr.insertCell().textContent = money(r.amount);
    tr.insertCell().textContent = money(r.amount / 12);
  }
}

function renderLegendInto(el, colorMap, categories) {
  el.textContent = '';
  for (const cat of categories) {
    const key = document.createElement('span');
    key.className = 'key';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = colorMap.get(cat) || theme().other;
    key.appendChild(sw);
    key.appendChild(document.createTextNode(cat));
    el.appendChild(key);
  }
}

function renderLegend(colorMap, categories) {
  renderLegendInto($('cat-legend'), colorMap, categories);
}

function renderCatTable(thisMonth, yearAvg) {
  const table = $('cat-table');
  table.textContent = '';
  const head = table.createTHead().insertRow();
  for (const h of ['Category', 'This month', 'Monthly avg']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const avgMap = new Map(yearAvg.map((c) => [c.category, c.amount]));
  const monthMap = new Map(thisMonth.map((c) => [c.category, c.amount]));
  const cats = [...new Set([...yearAvg, ...thisMonth].map((c) => c.category))];
  const body = table.createTBody();
  for (const cat of cats) {
    const row = body.insertRow();
    row.insertCell().textContent = cat;
    row.insertCell().textContent = money(monthMap.get(cat) || 0);
    row.insertCell().textContent = money(avgMap.get(cat) || 0);
  }
}

// A card per tracker category: bar chart on the left, merchant breakdown on the
// right. Built from summary.trackers, so adding a tracker in settings is all it
// takes to get a section here.
function renderTrackers(labels, palette) {
  const host = $('trackers');
  host.textContent = '';
  for (const tracker of summary.trackers) {
    const section = document.createElement('section');
    section.className = 'card';
    const title = document.createElement('h2');
    title.textContent = tracker.name;
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = tracker.excludeFromSpending
      ? 'Tracked separately — never counted as normal spending. Grouped by merchant.'
      : 'Counted in your spending totals as well. Grouped by merchant.';
    const grid = document.createElement('div');
    grid.className = 'grid-2';
    const chartBox = document.createElement('div');
    chartBox.className = 'chart-box';
    const canvas = document.createElement('canvas');
    chartBox.appendChild(canvas);
    const tableBox = document.createElement('div');
    const table = document.createElement('table');
    table.className = 'cats';
    const head = table.createTHead().insertRow();
    for (const h of ['Merchant', 'This month', 'Last 12 months']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const entry of tracker.breakdown) {
      const row = body.insertRow();
      row.insertCell().textContent = entry.name;
      row.insertCell().textContent = money(entry.thisMonth);
      row.insertCell().textContent = money(entry.total12m);
    }
    tableBox.appendChild(table);
    grid.append(chartBox, tableBox);
    section.append(title, sub, grid);
    host.appendChild(section);

    charts.push(makeBarChart(canvas, labels, tracker.months, {
      color: palette(tracker.id),
      name: tracker.name,
    }));
  }
}

function render() {
  charts.forEach((c) => c.destroy());
  charts = [];

  renderTiles();

  const t = theme();
  // The running month is only part-finished; a bar the same shape as the others
  // reads as a completed month, so say so on the axis and in the tooltip too.
  const partial = summary.partialMonth || {};
  const labels = summary.months.map((m) =>
    m.partial && partial.daysElapsed
      ? `${monthLabel(m.month)} (${partial.daysElapsed}/${partial.daysInMonth})`
      : monthLabel(m.month));
  charts.push(
    makeBarChart($('monthly-chart'), labels, summary.months.map((m) => m.chartSpend), {
      color: t.accent,
      fadedLast: true,
      name: 'Spending',
      lastIsPartial: Boolean(partial.daysElapsed),
    })
  );
  // Trackers are user-defined, so their colours cannot come from a fixed list of
  // ids. The three that predate the category unification keep the accents they
  // have always had; anything else takes the next series colour, skipping the one
  // that equals --accent so a tracker never draws in the spending chart's colour.
  // Before this, every tracker beyond those three was the same blue as the others.
  const trackerColour = (() => {
    const legacy = { investments: t.invest, renovation: t.renovation, taxes: t.tax };
    const spare = t.series.filter((c) => c !== t.accent);
    const assigned = new Map();
    let next = 0;
    for (const tracker of summary.trackers || []) {
      const colour = legacy[tracker.id] || spare[next++ % spare.length];
      assigned.set(tracker.id, colour);
    }
    return (id) => assigned.get(id) || t.accent;
  })();
  renderTrackers(labels, trackerColour);

  renderMonthlySub();
  renderIncome(labels, t);

  const { map: colorMap, folded } = categoryColorMap();
  const monthCats = foldCats(summary.categoriesThisMonth, folded);
  const avgCats = foldCats(summary.categoriesYearAvg, folded);
  const noChart = chartExcluded();
  const pieMonthCats = monthCats.filter((c) => !noChart.has(c.category));
  const pieAvgCats = avgCats.filter((c) => !noChart.has(c.category));
  const cm = currentMonthKey();
  charts.push(
    makeDonut($('pie-month'), pieMonthCats, colorMap, (cat) =>
      go(`#/month/${encodeURIComponent(cm)}/${encodeURIComponent(cat)}`)
    )
  );
  charts.push(
    makeDonut($('pie-avg'), pieAvgCats, colorMap, (cat) => go(`#/year/${encodeURIComponent(cat)}`))
  );

  const legendCats = [...colorMap.keys()].filter(
    (c) => pieMonthCats.some((x) => x.category === c) || pieAvgCats.some((x) => x.category === c)
  );
  renderLegend(colorMap, legendCats);
  renderCatTable(monthCats, avgCats);

  // When the transactions were pulled from Lunchflow — not when these totals
  // were added up, which is always "just now" and told you nothing.
  const fetched = summary.fetchedAt ? new Date(summary.fetchedAt) : null;
  const when = fetched
    ? fetched.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    : 'unknown';
  const age = fetched ? describeAge(Date.now() - fetched.getTime()) : '';
  $('meta').textContent = `Data as of ${when}${age ? ` (${age})` : ''}`;
  if (summary.refreshing) $('meta').textContent += ' · updating…';
  // Name what was actually held out. A category excluded from spending without
  // a tracker has no section anywhere, so this line is the only trace of it.
  const hidden = summary.hiddenFromSpending || [];
  if (hidden.length) {
    const parts = hidden.map((h) => `${h.name.toLowerCase()} ${money(h.total)}`).join(', ');
    $('meta').textContent += ` · ${summary.internalTransfersIgnored} kept out of spending (${parts})`;
  } else if (summary.internalTransfersIgnored) {
    $('meta').textContent += ` · ${summary.internalTransfersIgnored} internal transfers ignored`;
  }
  if (summary.manuallyExcluded) {
    $('meta').textContent += ` · ${summary.manuallyExcluded} excluded manually`;
  }
  if (summary.unconvertedCurrencyTransactions) {
    $('meta').textContent += ` · ${summary.unconvertedCurrencyTransactions} transactions excluded (FX unavailable)`;
  }
  $('cats-sub').textContent =
    'Where the money goes — this month vs the monthly average over the last 12 full months.';
}

/* ---------- data + events ---------- */

async function load(refresh = false) {
  $('err').textContent = '';
  $('app').classList.add('loading'); // hold the previous frame at reduced opacity
  try {
    if (refresh) globalSearchData = null;
    const res = await fetch('/api/summary' + (refresh ? '?refresh=1' : ''));
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    summary = await res.json();
    render();
    loadOutliers();
    watchRefresh();
  } catch (err) {
    $('err').textContent = err.message;
  } finally {
    $('app').classList.remove('loading');
  }
}

// The server can answer from a cached pull while it fetches a newer one behind
// the request. Poll until that lands so the numbers on screen catch up on their
// own, rather than sitting stale until the next click.
let refreshWatch = null;
function watchRefresh() {
  clearTimeout(refreshWatch);
  if (!summary || !summary.refreshing) return;
  const startedFrom = summary.fetchedAt;
  refreshWatch = setTimeout(async () => {
    try {
      const res = await fetch('/api/summary');
      if (!res.ok) return;
      const next = await res.json();
      if (next.fetchedAt !== startedFrom) {
        summary = next;
        if (!view) render(); // don't yank a detail page out from under the reader
        loadOutliers();
      } else {
        summary.refreshing = next.refreshing;
      }
      watchRefresh();
    } catch (_err) {
      /* the next page load will pick it up */
    }
  }, 3000);
}

/* ---------- transaction list rendering (shared by the detail page) ---------- */

// One dropdown classifies a transaction: pick a spending category, a special
// bucket, or Auto to fall back to the rules.
// The only two states left that are not a category: force plain spending, or
// drop the transaction from analytics entirely.
const SPECIAL_KINDS = [
  { state: 'spend', text: 'Spending (no category)' },
  { state: 'excluded', text: 'Excluded from analytics' },
];

// A small ▾ button that opens the manual-classification menu: a native select
// stretched invisibly over the icon, so the browser's own dropdown does the
// work. There is no always-visible control — the row already says what the
// transaction is; this exists only to override it (or go back to Auto).
function classifyControl(tx) {
  const wrap = document.createElement('span');
  wrap.className = 'classify-btn' + (tx.override || tx.categoryIdOverride ? ' overridden' : '');
  wrap.title = tx.override || tx.categoryIdOverride
    ? 'Manually classified — change it or pick "Auto (rules)" to undo'
    : 'Classify manually';
  wrap.textContent = '▾';

  const sel = document.createElement('select');
  sel.appendChild(new Option('Auto (rules)', 'auto'));

  // Trackers and the transfer bucket are categories now, so they appear in the
  // same list — just grouped apart from the ones that count as spending.
  const all = rulesDocCache ? rulesDocCache.categories : [];
  for (const [label, list] of [
    ['Category', all.filter((c) => !c.excludeFromSpending)],
    ['Tracked separately', all.filter((c) => c.excludeFromSpending)],
  ]) {
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const cat of list) group.appendChild(new Option(cat.name, 'cat:' + cat.id));
    sel.appendChild(group);
  }

  const specialGroup = document.createElement('optgroup');
  specialGroup.label = 'Special';
  for (const k of SPECIAL_KINDS) specialGroup.appendChild(new Option(k.text, 'kind:' + k.state));
  sel.appendChild(specialGroup);

  sel.value = tx.categoryIdOverride
    ? 'cat:' + tx.categoryIdOverride
    : tx.override ? 'kind:' + tx.override : 'auto';
  sel.addEventListener('change', () => {
    if (sel.value === 'auto') setClassification(tx.id, null, null);
    else if (sel.value.startsWith('cat:')) setClassification(tx.id, null, sel.value.slice(4));
    else setClassification(tx.id, sel.value.slice(5), null);
  });
  sel.addEventListener('click', (e) => e.stopPropagation());
  wrap.appendChild(sel);
  return wrap;
}

function kindLabel(tx) {
  if (tx.kind === 'excluded') return 'Excluded from analytics';
  if (tx.kind === 'tracked') return tx.label || 'Internal transfer';
  if (tx.returnOf) return 'Return';
  if (tx.refundAmount > 0) {
    return `${tx.label || 'Spending'} · ${transactionMoney(tx.refundAmount, tx.currency)} returned`;
  }
  if (tx.amount >= 0) return 'Income';
  if (!tx.label) return '—';
  return tx.label + (tx.categoryOverride ? ' · manual' : '');
}

// Sort applied to every transaction list. Date keeps the incoming
// (newest-first) order; amount sorts by the absolute converted value.
let txSort = { key: 'date', dir: 'desc' };

function sortTransactions(transactions) {
  const sorted = [...transactions];
  if (txSort.key === 'amount') {
    const magnitude = (tx) => Math.abs(tx.baseAmount ?? tx.originalAmount);
    sorted.sort((a, b) => (magnitude(b) - magnitude(a)) * (txSort.dir === 'desc' ? 1 : -1));
  } else if (txSort.dir === 'asc') {
    sorted.reverse();
  }
  return sorted;
}

function renderTxTable(container, transactions) {
  container.textContent = '';
  container._txs = transactions; // header clicks re-render this same list
  if (!transactions.length) {
    const p = document.createElement('div');
    p.className = 'tx-empty';
    p.textContent = 'No transactions here.';
    container.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  table.className = 'txs';
  const head = table.createTHead().insertRow();
  for (const h of ['Date', 'Merchant', 'Amount', 'Classification']) {
    const th = document.createElement('th');
    const key = h === 'Date' ? 'date' : h === 'Amount' ? 'amount' : null;
    th.textContent = h + (txSort.key === key ? (txSort.dir === 'desc' ? ' ↓' : ' ↑') : '');
    if (h === 'Amount') th.style.textAlign = 'right';
    if (key) {
      th.className = 'sortable';
      th.title = `Sort by ${h.toLowerCase()}`;
      th.addEventListener('click', () => {
        txSort = txSort.key === key
          ? { key, dir: txSort.dir === 'desc' ? 'asc' : 'desc' }
          : { key, dir: 'desc' };
        renderTxTable(container, container._txs);
      });
    }
    head.appendChild(th);
  }

  const tbody = table.createTBody();
  for (const tx of sortTransactions(transactions)) {
    const row = tbody.insertRow();
    // Transfers and exclusions are struck through: they are in no total.
    const inNoTotal = tx.kind === 'excluded' || (tx.kind === 'tracked' && !tx.label);
    row.className = 'tx-row' + (inNoTotal ? ' is-internal' : '');
    row.id = 'transaction-' + tx.id;

    const dateCell = row.insertCell();
    dateCell.className = 'tx-date';
    dateCell.textContent = tx.date.slice(8, 10) + ' ' + monthLabel(tx.date.slice(0, 7));

    const mCell = row.insertCell();
    const mName = document.createElement('div');
    mName.className = 'tx-merchant';
    mName.innerHTML = '<span class="tx-caret">▸</span>';
    mName.append(tx.merchant);
    const acct = document.createElement('div');
    acct.className = 'tx-acct';
    acct.append(tx.account + (kindLabel(tx) !== '—' ? ' · ' + kindLabel(tx) : ''));
    if (tx.returnOf) {
      const original = document.createElement('a');
      original.className = 'tx-return-link';
      original.href = `#/month/${tx.returnOf.date.slice(0, 7)}?transaction=${encodeURIComponent(tx.returnOf.id)}`;
      original.textContent = `Original transaction · ${tx.returnOf.date}`;
      original.addEventListener('click', (e) => e.stopPropagation());
      acct.append(' · ', original);
    }
    for (const returned of tx.returnTransactions || []) {
      const returnLink = document.createElement('a');
      returnLink.className = 'tx-return-link';
      returnLink.href = `#/month/${returned.date.slice(0, 7)}?transaction=${encodeURIComponent(returned.id)}`;
      returnLink.textContent = `Return transaction · ${returned.date}`;
      returnLink.addEventListener('click', (e) => e.stopPropagation());
      acct.append(' · ', returnLink);
    }
    mCell.append(mName, acct);

    const aCell = row.insertCell();
    aCell.className = 'col-amount' + (tx.originalAmount >= 0 ? ' income' : '');
    if (tx.returnOf) {
      aCell.textContent = '+' + transactionMoney(tx.originalAmount, tx.currency);
    } else if (tx.refundAmount > 0) {
      const originalSpend = Math.abs(tx.originalAmount);
      aCell.textContent = `${transactionMoney(originalSpend, tx.currency)} − ${transactionMoney(tx.refundAmount, tx.currency)} = ${transactionMoney(Math.abs(tx.amount), tx.currency)}`;
      const counted = document.createElement('div');
      counted.className = 'tx-counted';
      counted.textContent = 'counted as spending';
      aCell.appendChild(counted);
    } else {
      aCell.textContent = (tx.amount >= 0 ? '+' : '−') + transactionMoney(Math.abs(tx.amount), tx.currency);
    }
    if (tx.currency !== tx.baseCurrency && tx.baseAmount !== null && tx.originalAmount < 0) {
      const converted = document.createElement('div');
      converted.className = 'tx-counted';
      converted.textContent = `≈ ${transactionMoney(Math.abs(tx.baseAmount), tx.baseCurrency)} in totals`;
      if (tx.exchangeRateDate) converted.title = `Reference rate from ${tx.exchangeRateDate}`;
      aCell.appendChild(converted);
    } else if (tx.currency !== tx.baseCurrency && tx.baseAmount === null) {
      const unavailable = document.createElement('div');
      unavailable.className = 'tx-counted';
      unavailable.textContent = 'FX rate unavailable · excluded from totals';
      aCell.appendChild(unavailable);
    }

    // One compact cell with two independent parts: the AI verdict/actions
    // (rebuilt whenever a review lands) and the manual controls (exclude + ▾).
    // They are separate elements so a background AI refresh never destroys the
    // dropdown the user might have open.
    const cCell = row.insertCell();
    const ai = document.createElement('div');
    ai.className = 'tx-ai';
    const manual = document.createElement('div');
    manual.className = 'tx-manual';
    appendManualControls(manual, tx);
    cCell.append(ai, manual);
    renderAiCell(ai, tx);

    // Expandable detail row with the full raw transaction from Lunchflow.
    const detail = tbody.insertRow();
    detail.className = 'tx-detail';
    detail.hidden = true;
    const dCell = detail.insertCell();
    dCell.colSpan = 4;
    const similar = document.createElement('div');
    similar.className = 'tx-similar';
    dCell.append(similar, rawDetail(tx.raw));

    row.addEventListener('click', (e) => {
      if (e.target.closest('select, .tx-ai, .tx-manual')) return; // don't toggle when using the controls
      detail.hidden = !detail.hidden;
      row.classList.toggle('open', !detail.hidden);
      if (!detail.hidden) loadSimilar(tx.id, similar);
    });
  }
  container.appendChild(table);
}

// Fuzzy merchant matches for one transaction, fetched the first time its row is
// expanded and then left in place (the answer only changes when rules do).
async function loadSimilar(txId, el) {
  if (el.dataset.loaded) return;
  el.dataset.loaded = '1';
  el.textContent = 'Looking for similar transactions…';
  try {
    const res = await fetch(`/api/transactions/${encodeURIComponent(txId)}/similar`);
    if (!res.ok) throw new Error(`Failed (${res.status})`);
    const similar = await res.json();
    el.textContent = '';
    const heading = document.createElement('div');
    heading.className = 'preview-summary';
    heading.textContent = similar.count
      ? `Similar merchants · ${money(Math.abs(similar.totalBase))} in total`
      : 'No similar merchants in the last 12 months.';
    el.appendChild(heading);
    if (similar.count) {
      const body = document.createElement('div');
      renderPreviewInto(body, similar);
      el.appendChild(body);
    }
  } catch (err) {
    el.textContent = err.message;
    delete el.dataset.loaded; // let the next expand retry
  }
}

// A definition-style list of every field in the raw transaction object.
function rawDetail(raw) {
  const dl = document.createElement('dl');
  dl.className = 'raw';
  for (const [key, value] of Object.entries(raw || {})) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent =
      value === null || typeof value !== 'object' ? String(value) : JSON.stringify(value);
    dl.append(dt, dd);
  }
  return dl;
}

function searchCriteria(prefix) {
  const numberOrNull = (id) => {
    const value = $(id).value.trim();
    return value === '' ? null : Number(value);
  };
  return {
    text: $(`${prefix}-search-text`).value.trim().toLowerCase(),
    min: numberOrNull(`${prefix}-search-min`),
    max: numberOrNull(`${prefix}-search-max`),
    type: $(`${prefix}-search-type`).value,
  };
}

function hasSearchCriteria(criteria) {
  return Boolean(criteria.text || criteria.min !== null || criteria.max !== null || criteria.type !== 'all');
}

function transactionType(tx) {
  if (tx.returnOf) return 'return';
  if (tx.kind === 'excluded') return 'excluded';
  if (tx.kind === 'tracked') return tx.categoryId || 'internal';
  if (tx.originalAmount > 0) return 'income';
  return 'spend';
}

function filterTransactions(transactions, criteria) {
  return transactions.filter((tx) => {
    const amount = Math.abs(tx.originalAmount);
    if (criteria.min !== null && amount < criteria.min) return false;
    if (criteria.max !== null && amount > criteria.max) return false;
    if (criteria.type !== 'all' && transactionType(tx) !== criteria.type) return false;
    if (criteria.text) {
      const searchable = [tx.merchant, tx.account, tx.label, tx.kind, JSON.stringify(tx.raw || {})]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(criteria.text)) return false;
    }
    return true;
  });
}

function clearSearch(prefix) {
  $(`${prefix}-search-text`).value = '';
  $(`${prefix}-search-min`).value = '';
  $(`${prefix}-search-max`).value = '';
  $(`${prefix}-search-type`).value = 'all';
}

let globalSearchData = null;
let globalSearchResults = [];
let detailFilteredTransactions = [];

function downloadRawTransactions(transactions, filename) {
  const raw = transactions.map((tx) => tx.raw || tx);
  const blob = new Blob([JSON.stringify(raw, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function runGlobalSearch() {
  const criteria = searchCriteria('global');
  if (!hasSearchCriteria(criteria)) {
    globalSearchResults = [];
    $('global-search-download').disabled = true;
    $('global-search-results').textContent = '';
    $('global-search-status').textContent = 'Enter one or more filters to search.';
    return;
  }
  $('global-search-status').textContent = 'Searching…';
  try {
    if (!globalSearchData) {
      const res = await fetch('/api/transactions?range=year');
      if (res.status === 401) return (location.href = '/login');
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      globalSearchData = (await res.json()).transactions;
    }
    await fetchRulesDoc().catch(() => {}); // category names for the classification dropdowns
    const results = filterTransactions(globalSearchData, criteria);
    globalSearchResults = results;
    $('global-search-download').disabled = results.length === 0;
    $('global-search-status').textContent = `${results.length} matching transaction${results.length === 1 ? '' : 's'}`;
    renderTxTable($('global-search-results'), results);
    loadCachedReviews(results).then(() => autoReviewRecent(results));
  } catch (err) {
    globalSearchResults = [];
    $('global-search-download').disabled = true;
    $('global-search-status').textContent = err.message;
  }
}

// Set the manual classification in one call: state is a kind (or null for
// automatic), category pins a spending category (null clears it; leave the
// argument out to keep any existing manual category untouched).
async function setClassification(txId, state, categoryId) {
  const res = await fetch(`/api/transactions/${encodeURIComponent(txId)}/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(categoryId === undefined ? { state } : { state, categoryId }),
  });
  if (!res.ok) return;
  await reloadAfterClassificationChange();
}

// The tail of every classification cell: a one-click exclude/include toggle
// plus the ▾ menu with the full option list.
function appendManualControls(el, tx) {
  if (tx.kind === 'excluded') {
    el.appendChild(aiControl('button', '↩ include', 'ai-btn ghost',
      'Put this transaction back into the analytics', () => setClassification(tx.id, null)));
  } else {
    el.appendChild(aiControl('button', '✕ exclude', 'ai-btn ghost',
      'Exclude this transaction from all charts and totals', () => setClassification(tx.id, 'excluded')));
  }
  el.appendChild(classifyControl(tx));
}

// Re-render whichever view is active after anything that changes how
// transactions are classified (kind/category overrides, rule edits).
async function reloadAfterClassificationChange() {
  dashboardDirty = true; // charts on the dashboard need recomputing when we go back
  detailData = null; // force a refetch so the list reflects the new classification
  globalSearchData = null;
  if (view && view.scope !== 'settings') await renderDetail();
  else if (!view) {
    await load();
    await runGlobalSearch();
  }
}

/* ---------- detail page + hash routing ---------- */

let view = null; // { scope:'month'|'year', month, category } or null on the dashboard
let detailData = null; // { key, currency, transactions } cached for the current scope
let detailChart = null;
let dashboardDirty = false;

function go(hash) {
  location.hash = hash;
}
function currentMonthKey() {
  return summary && summary.months.find((m) => m.partial).month;
}

// Keep every named category distinct so chart filtering always maps to the label
// shown on the transaction. Colors repeat after the fixed palette is exhausted.
function buildCatColors(sortedCats) {
  const t = theme();
  const named = sortedCats.map((c) => c.category).filter((c) => c !== 'Other');
  const map = new Map();
  named.forEach((c, i) => map.set(c, t.series[i % t.series.length]));
  const folded = new Set();
  map.set('Other', t.other);
  return { map, folded };
}
const foldCat = (cat, folded) => (folded.has(cat) ? 'Other' : cat || 'Other');

function parseHash() {
  const [raw, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  if (!raw) return null;
  const p = raw.split('/').map(decodeURIComponent);
  const transaction = new URLSearchParams(query).get('transaction');
  if (p[0] === 'month' && /^\d{4}-\d{2}$/.test(p[1] || '')) {
    return { scope: 'month', month: p[1], category: p[2] || null, transaction };
  }
  if (p[0] === 'year') return { scope: 'year', month: null, category: p[1] || null };
  if (p[0] === 'miscat') return { scope: 'miscat', month: null, category: null };
  if (p[0] === 'settings') return { scope: 'settings', month: null, category: null };
  return null;
}

async function route() {
  const v = parseHash();
  if (!v) return showDashboard();
  view = v;
  if (v.scope === 'settings') return renderSettings();
  $('settings').hidden = true;
  if (v.transaction) clearSearch('detail');
  await renderDetail();
}

function showDashboard() {
  view = null;
  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }
  $('detail').hidden = true;
  $('settings').hidden = true;
  $('dashboard').hidden = false;
  window.scrollTo(0, 0);
  loadOutliers(); // reviews may have landed while we were on another view
  if (dashboardDirty) {
    dashboardDirty = false;
    load(); // recompute charts from cached data with any new overrides (no API hit)
  }
}

function navFilter(category) {
  const base = view.scope === 'year' ? '#/year' : `#/month/${encodeURIComponent(view.month)}`;
  go(category ? `${base}/${encodeURIComponent(category)}` : base);
}

async function renderDetail() {
  if (view.scope === 'miscat') return renderMiscat();
  $('dashboard').hidden = true;
  $('detail').hidden = false;
  $('detail-err').textContent = '';
  $('detail-search-form').hidden = false;
  const isYear = view.scope === 'year';
  $('detail-title').textContent = isYear ? 'Last 12 months' : monthLabel(view.month);
  window.scrollTo(0, 0);

  const key = isYear ? 'year' : 'month:' + view.month;
  try {
    if (!detailData || detailData.key !== key) {
      $('detail-list').textContent = '';
      $('detail-sub').textContent = 'Loading…';
      const url = isYear
        ? '/api/transactions?range=year'
        : '/api/transactions?month=' + encodeURIComponent(view.month);
      const res = await fetch(url);
      if (res.status === 401) return (location.href = '/login');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      detailData = { key, currency: data.currency, transactions: data.transactions };
    }
    await fetchRulesDoc().catch(() => {}); // category names for the classification dropdowns
    renderDetailBody();
  } catch (err) {
    $('detail-sub').textContent = '';
    $('detail-err').textContent = err.message;
  }
}

function renderDetailBody() {
  const txns = detailData.transactions;
  const spend = txns.filter((t) => t.kind === 'spend' && t.baseAmount < 0);

  // Category totals for the pie (spend only), folded to top-8 + Other.
  const totals = new Map();
  const noChart = chartExcluded();
  for (const t of spend) {
    const c = t.label || 'Other';
    if (noChart.has(c)) continue;
    totals.set(c, (totals.get(c) || 0) + -t.baseAmount);
  }
  const sorted = [...totals]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
  const { map, folded } = buildCatColors(sorted);
  const pieTotals = new Map();
  for (const { category, amount } of sorted) {
    const k = foldCat(category, folded);
    pieTotals.set(k, (pieTotals.get(k) || 0) + amount);
  }
  const pieCats = [...pieTotals]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  if (detailChart) {
    detailChart.destroy();
    detailChart = null;
  }
  if (pieCats.length) {
    $('detail-pie-card').hidden = false;
    detailChart = makeDonut($('detail-pie'), pieCats, map, (cat) =>
      navFilter(view.category === cat ? null : cat)
    );
    renderLegendInto($('detail-legend'), map, pieCats.map((c) => c.category));
  } else {
    $('detail-pie-card').hidden = true;
  }

  // Filter chip (clears the category on click).
  const chip = $('detail-filter');
  if (view.category) {
    chip.hidden = false;
    chip.textContent = view.category + ' ';
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    chip.appendChild(x);
    chip.onclick = () => navFilter(null);
  } else {
    chip.hidden = true;
    chip.onclick = null;
  }

  // The list: filtered to the selected spend category, or everything.
  const categoryList = view.category
    ? spend.filter((t) => foldCat(t.label || 'Other', folded) === view.category)
    : txns;
  renderProviderBreakdown(view.scope === 'year' && view.category ? categoryList : null);
  const criteria = searchCriteria('detail');
  const list = filterTransactions(categoryList, criteria);
  detailFilteredTransactions = list;
  $('detail-search-download').disabled = list.length === 0;
  const shownSpend = (view.category || hasSearchCriteria(criteria) ? list : spend).reduce(
    (s, t) => s + (t.kind === 'spend' && t.baseAmount < 0 ? -t.baseAmount : 0),
    0
  );
  $('detail-list-title').textContent = view.category || 'Transactions';
  $('detail-sub').textContent = `${list.length} transactions · ${money(shownSpend)} spent`;
  renderTxTable($('detail-list'), list);
  loadCachedReviews(list).then(() => autoReviewRecent(list));
  if (view.transaction) {
    const target = document.getElementById('transaction-' + view.transaction);
    if (target) {
      target.classList.add('is-linked');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

/* ---------- AI reviews ---------- */

const aiReviews = new Map(); // txId -> review object | 'loading' | { error }

/**
 * Whether this account has the AI review at all — it needs an OpenAI key, and
 * setup no longer insists on one. Assumed on until /api/me says otherwise, so a
 * failed or slow answer leaves the app exactly as it was.
 *
 * With it off, every AI control is left off the page rather than shown and
 * disabled: a button whose only possible outcome is "AI review is not
 * configured" is worse than no button.
 */
let aiReview = true;

function aiEligible(tx) {
  return tx.kind === 'spend' && tx.originalAmount < 0 && !tx.returnOf;
}

function refreshAiCells(txId) {
  for (const el of document.querySelectorAll('.tx-ai')) {
    if (el.dataset.tx === String(txId) && el._tx) renderAiCell(el, el._tx);
  }
}

// Every AI cell on screen, for when the answer to "is the review on?" lands
// after the rows were drawn.
function repaintAiCells() {
  for (const el of document.querySelectorAll('.tx-ai')) {
    if (el._tx) renderAiCell(el, el._tx);
  }
}

function aiControl(tag, text, cls, title, onClick) {
  const el = document.createElement(tag);
  el.textContent = text;
  el.className = cls;
  if (title) el.title = title;
  if (onClick) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return el;
}

// The server's sweep config ({ light, months }) drives which rows get their
// review computed automatically. Until it arrives (or in light mode) nothing
// auto-triggers — rows show the on-demand AI check button instead.
let aiConfig = null;

function inAutoWindow(tx) {
  if (!aiConfig || aiConfig.light) return false;
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (aiConfig.months - 1));
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return tx.date.slice(0, 7) >= cutoff;
}

// Renders only the AI verdict/action badges — the manual classify controls
// live in a sibling .tx-manual element that this never touches, so a
// background refresh can't destroy a dropdown mid-interaction.
function renderAiCell(el, tx) {
  el.textContent = '';
  el.dataset.tx = tx.id;
  el._tx = tx;
  if (!aiReview) return; // no OpenAI key on this account: the column stays empty
  if (!aiEligible(tx)) return; // income/transfer/etc.: no AI, manual controls handled separately

  const r = aiReviews.get(String(tx.id));
  if (r === 'loading') {
    el.appendChild(aiControl('span', 'AI reviewing…', 'ai-badge'));
  } else if (!r) {
    if (inAutoWindow(tx)) {
      // In-window transactions are reviewed automatically; this resolves shortly.
      el.appendChild(aiControl('span', 'AI…', 'ai-badge', 'AI review pending'));
    } else {
      el.appendChild(aiControl('button', '✨ AI check', 'ai-btn',
        'Outside the automatic review window — ask GPT to review this classification',
        () => reviewOne(tx.id)));
    }
  } else if (r.error) {
    el.appendChild(aiControl('span', 'AI failed', 'ai-badge err', r.error));
    el.appendChild(aiControl('button', '↻', 'ai-btn ghost', 'Retry', () => reviewOne(tx.id)));
  } else {
    if (r.assessment === 'correct') {
      el.appendChild(aiControl('span', '✓ AI agrees', 'ai-badge ok', r.reasoning));
    }
    if (r.suggestedCategory && r.suggestedCategory !== tx.label) {
      el.appendChild(aiControl('button', `→ ${r.suggestedCategory}`, 'ai-btn suggest',
        `${r.reasoning} Click to classify this transaction as ${r.suggestedCategory}.`,
        () => setClassification(tx.id, 'spend', r.suggestedCategory)));
    }
    if (r.proposedRule) {
      const others = r.proposedRule.matchCount;
      el.appendChild(aiControl('button', `+ rule${typeof others === 'number' ? ` (${others})` : ''}`, 'ai-btn',
        `Add rule "${r.proposedRule.pattern}" → ${r.proposedRule.category}`
          + (typeof others === 'number' ? ` — matches ${others} other transaction${others === 1 ? '' : 's'}` : '')
          + ' (preview before applying)',
        () => openRuleModal(r.proposedRule)));
    }
    if (r.isOutlier && r.outlierReviewed) {
      el.appendChild(aiControl('span', '⚠ outlier · reviewed', 'ai-badge', r.outlierReason || ''));
    } else if (r.isOutlier) {
      el.appendChild(aiControl('span', '⚠ outlier', 'ai-badge warn', r.outlierReason || ''));
      const note = document.createElement('div');
      note.className = 'ai-note';
      note.textContent = r.outlierReason || '';
      el.appendChild(note);
      el.appendChild(aiControl('button', 'reviewed ✓', 'ai-btn ghost', 'Mark this outlier as reviewed', () => ackOutliers([tx.id])));
    }
    el.appendChild(aiControl('button', '↻', 'ai-btn ghost', 'Re-run the AI review', () => reviewOne(tx.id, true)));
    const row = el.closest('tr');
    if (row) row.classList.toggle('is-outlier', Boolean(r.isOutlier && !r.outlierReviewed));
  }
}

// Kick off reviews for in-window transactions that have no cached result yet —
// the server dedupes against the background sweep, so nothing runs twice.
function autoReviewRecent(transactions) {
  for (const tx of transactions) {
    if (!aiEligible(tx)) continue;
    if (!inAutoWindow(tx)) continue;
    if (aiReviews.has(String(tx.id))) continue;
    reviewOne(tx.id);
  }
}

// refresh=true re-fetches ids we already know about — used while a sweep is
// running, because it may be recomputing reviews we already display.
async function loadCachedReviews(transactions, refresh = false) {
  const ids = transactions.filter(aiEligible).map((t) => String(t.id))
    .filter((id) => refresh || !aiReviews.has(id));
  if (!ids.length) return;
  try {
    const res = await fetch('/api/reviews/cached', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return;
    let changed = 0;
    for (const [id, r] of Object.entries(await res.json())) {
      const prev = aiReviews.get(id);
      if (prev === 'loading') continue; // a row-triggered review is in flight
      if (prev && prev.at === r.at) continue;
      aiReviews.set(id, r);
      refreshAiCells(id);
      changed++;
    }
    if (changed) scheduleOutliersRefresh();
  } catch (_err) { /* cached reviews are decoration; never break the list */ }
}

// Refresh the outlier inbox shortly after new review results arrive, collapsing
// bursts (an auto-reviewed month can finish dozens of reviews in seconds).
let outliersRefreshTimer = null;
function scheduleOutliersRefresh() {
  clearTimeout(outliersRefreshTimer);
  outliersRefreshTimer = setTimeout(loadOutliers, 800);
}

async function reviewOne(txId, force = false) {
  const id = String(txId);
  aiReviews.set(id, 'loading');
  refreshAiCells(id);
  try {
    const res = await fetch(`/api/transactions/${encodeURIComponent(id)}/review${force ? '?force=1' : ''}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return (location.href = '/login');
    if (!res.ok) throw new Error(body.error || `Review failed (${res.status})`);
    aiReviews.set(id, body);
    scheduleOutliersRefresh(); // a fresh result may add to (or change) the inbox
  } catch (err) {
    aiReviews.set(id, { error: err.message });
  }
  refreshAiCells(id);
}

/* ---------- outlier inbox on the dashboard ---------- */

async function loadOutliers() {
  try {
    const res = await fetch('/api/reviews/outliers');
    if (!res.ok) return;
    renderOutliers(await res.json());
  } catch (_err) { /* the inbox is decoration; never break the dashboard */ }
}

// One table of individual outlier transactions (used for the last-7-days
// section and inside expanded merchant groups).
function outlierEntryTable(entries) {
  const table = document.createElement('table');
  table.className = 'txs';
  const head = table.createTHead().insertRow();
  for (const h of ['Date', 'Merchant', 'Amount', 'Why unusual', '']) {
    const th = document.createElement('th');
    th.textContent = h;
    if (h === 'Amount') th.style.textAlign = 'right';
    head.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const o of entries) {
    const row = tbody.insertRow();
    row.className = 'is-outlier';
    row.insertCell().textContent = o.date;

    const mCell = row.insertCell();
    const link = document.createElement('a');
    link.className = 'tx-return-link';
    link.href = `#/month/${o.date.slice(0, 7)}?transaction=${encodeURIComponent(o.id)}`;
    link.textContent = o.merchant;
    mCell.appendChild(link);
    const acct = document.createElement('div');
    acct.className = 'tx-acct';
    acct.textContent = `${o.account} · ${o.label}`;
    mCell.appendChild(acct);

    const aCell = row.insertCell();
    aCell.className = 'col-amount';
    aCell.textContent = transactionMoney(o.amount, o.currency);

    const rCell = row.insertCell();
    rCell.className = 'outlier-reason';
    rCell.textContent = o.reason;

    const bCell = row.insertCell();
    bCell.style.textAlign = 'right';
    bCell.appendChild(aiControl('button', 'Mark reviewed', 'ai-btn',
      'Dismiss from this list (the review stays cached)', () => ackOutliers([o.id])));
  }
  return table;
}

function outliersHeading(text) {
  const h = document.createElement('div');
  h.className = 'outliers-h';
  h.textContent = text;
  return h;
}

// Explicit expand/collapse choices per merchant group, and a fingerprint of
// the last rendered payload: background polls re-render only when the content
// actually changed, and never clobber an expansion the user made.
const outlierGroupOpen = new Map();
let outliersFingerprint = null;

function renderOutliers({ recent, byMerchant, reviewedCount, flaggedCount }) {
  const fingerprint = JSON.stringify([
    recent.map((o) => o.id),
    byMerchant.map((g) => [g.name, g.count, g.total, g.outliers.map((o) => o.id)]),
    reviewedCount,
    flaggedCount,
  ]);
  if (fingerprint === outliersFingerprint) return; // nothing visible would change
  outliersFingerprint = fingerprint;

  const card = $('outliers-card');
  const list = $('outliers-list');
  list.textContent = '';
  // Visible whenever there is a review to have, so an empty inbox is a
  // statement rather than a mystery — but an account with no OpenAI key and no
  // reviews behind it (an import can bring some) is not being told anything by
  // an inbox for a feature it does not have.
  card.hidden = !aiReview && !reviewedCount;
  if (card.hidden) return;
  if (!byMerchant.length) {
    const empty = document.createElement('p');
    empty.className = 'tx-search-status';
    empty.textContent = reviewedCount
      ? `Nothing to review — GPT has looked at ${reviewedCount} transaction${reviewedCount === 1 ? '' : 's'}`
        + (flaggedCount ? ` (all ${flaggedCount} flagged outlier${flaggedCount === 1 ? '' : 's'} already reviewed).` : ' and flagged none.')
      // The card is not rendered at all without a review to run, so this is
      // always "on, but nothing has come back yet".
      : 'No AI reviews yet — they run automatically when the page loads.';
    list.appendChild(empty);
    return;
  }

  if (recent.length) {
    list.appendChild(outliersHeading('Flagged in the last 7 days'));
    list.appendChild(outlierEntryTable(recent));
  }

  list.appendChild(outliersHeading('All unreviewed, by merchant — highest flagged total first'));
  const table = document.createElement('table');
  table.className = 'txs';
  const head = table.createTHead().insertRow();
  for (const h of ['Merchant', 'Flagged', 'Total', 'Latest', '']) {
    const th = document.createElement('th');
    th.textContent = h;
    if (h === 'Total') th.style.textAlign = 'right';
    head.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const g of byMerchant) {
    const row = tbody.insertRow();
    row.className = 'tx-row is-outlier';

    const mCell = row.insertCell();
    const name = document.createElement('div');
    name.className = 'tx-merchant';
    name.innerHTML = '<span class="tx-caret">▸</span>';
    name.append(g.name);
    mCell.appendChild(name);

    row.insertCell().textContent = g.count;
    const tCell = row.insertCell();
    tCell.className = 'col-amount';
    tCell.textContent = money(g.total, 2);
    row.insertCell().textContent = g.latest;

    const bCell = row.insertCell();
    bCell.style.textAlign = 'right';
    bCell.appendChild(aiControl('button', 'Mark all reviewed', 'ai-btn',
      `Dismiss all ${g.count} flagged transactions from ${g.name}`,
      () => ackOutliers(g.outliers.map((o) => o.id))));

    // Expandable detail with the group's individual transactions. A group with
    // a single transaction starts open (there's nothing to summarize); the
    // user's explicit choice, either way, survives background re-renders.
    const explicit = outlierGroupOpen.get(g.name);
    const open = explicit !== undefined ? explicit : g.count === 1;
    const detail = tbody.insertRow();
    detail.className = 'tx-detail';
    detail.hidden = !open;
    row.classList.toggle('open', open);
    const dCell = detail.insertCell();
    dCell.colSpan = 5;
    dCell.appendChild(outlierEntryTable(g.outliers));

    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      detail.hidden = !detail.hidden;
      row.classList.toggle('open', !detail.hidden);
      outlierGroupOpen.set(g.name, !detail.hidden);
    });
  }
  list.appendChild(table);
}

async function ackOutliers(txIds) {
  await Promise.all(txIds.map(async (txId) => {
    const res = await fetch(`/api/reviews/${encodeURIComponent(txId)}/outlier-reviewed`, { method: 'POST' });
    if (!res.ok) return;
    const r = aiReviews.get(String(txId));
    if (r && typeof r === 'object') {
      r.outlierReviewed = true;
      refreshAiCells(txId);
    }
  }));
  await loadOutliers();
}

/* ---------- background AI sweep ---------- */

// On page load the server starts reviewing every uncached transaction in
// parallel; while that runs we poll for progress and pull fresh results into
// whatever list is on screen.

let sweepTimer = null;

async function startAiSweep() {
  try {
    const res = await fetch('/api/reviews/sweep', { method: 'POST' });
    if (!res.ok) return; // 503 = AI not configured; the feature just stays off
    updateSweepIndicator(await res.json());
  } catch (_err) { /* AI is optional */ }
}

function updateSweepIndicator(status) {
  if (status.config) aiConfig = status.config;
  if (status.running) {
    $('ai-progress').textContent = `· AI reviewing ${status.done}/${status.total}…`;
    if (!sweepTimer) sweepTimer = setInterval(pollSweep, 3000);
  } else {
    $('ai-progress').textContent = '';
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }
}

async function pollSweep() {
  try {
    const res = await fetch('/api/reviews/status');
    if (!res.ok) return;
    const status = await res.json();
    // Freshly finished (or recomputed) reviews land on whatever is visible.
    if (detailData) loadCachedReviews(detailData.transactions, true);
    if (globalSearchResults.length) loadCachedReviews(globalSearchResults, true);
    if (!view) loadOutliers(); // new outliers surface on the dashboard as they're found
    updateSweepIndicator(status);
  } catch (_err) { /* transient poll failures are fine */ }
}

/* ---------- add-rule modal ---------- */

let rulesDocCache = null;

// The type filter lists one entry per excluded-from-spending category, so a new
// tracker is filterable without touching the markup.
function syncTypeFilters() {
  const extra = (rulesDocCache ? rulesDocCache.categories : []).filter((c) => c.excludeFromSpending);
  for (const prefix of ['global', 'detail']) {
    const sel = $(`${prefix}-search-type`);
    if (!sel) continue;
    const keep = sel.value;
    for (const option of [...sel.querySelectorAll('option[data-category]')]) option.remove();
    for (const cat of extra) {
      const option = new Option(cat.name, cat.id);
      option.dataset.category = '1';
      sel.appendChild(option);
    }
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}

async function fetchRulesDoc(force = false) {
  if (rulesDocCache && !force) return rulesDocCache;
  const res = await fetch('/api/rules');
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Not authenticated');
  }
  if (!res.ok) throw new Error(`Failed to load rules (${res.status})`);
  rulesDocCache = await res.json();
  syncTypeFilters();
  return rulesDocCache;
}

async function openRuleModal(rule) {
  try {
    const doc = await fetchRulesDoc();
    const sel = $('rule-category');
    sel.textContent = '';
    for (const cat of doc.categories) {
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = cat.name;
      sel.appendChild(opt);
    }
    if (doc.categories.some((c) => c.name === rule.category)) sel.value = rule.category;
    $('rule-pattern').value = rule.pattern || '';
    $('rule-status').textContent = '';
    $('rule-preview').textContent = '';
    $('rule-modal').showModal();
    runRulePreview();
  } catch (err) {
    alert(err.message);
  }
}

let rulePreviewTimer = null;
function scheduleRulePreview() {
  clearTimeout(rulePreviewTimer);
  rulePreviewTimer = setTimeout(runRulePreview, 350);
}

async function runRulePreview() {
  const pattern = $('rule-pattern').value;
  const target = $('rule-preview');
  if (!pattern.trim()) {
    $('rule-status').textContent = 'Enter a pattern to preview its matches.';
    target.textContent = '';
    return;
  }
  $('rule-status').textContent = 'Checking matches…';
  try {
    const res = await fetch('/api/rules/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patterns: [pattern] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Preview failed (${res.status})`);
    const preview = await res.json();
    $('rule-status').textContent = '';
    renderPreviewInto(target, preview);
  } catch (err) {
    $('rule-status').textContent = err.name === 'TimeoutError'
      ? 'Preview timed out — edit the pattern to retry'
      : err.message;
  }
}

// Shared by the modal and the settings page: matches of a candidate rule.
function renderPreviewInto(el, preview) {
  el.textContent = '';
  const summary = document.createElement('div');
  summary.className = 'preview-summary';
  const byLabel = Object.entries(preview.byLabel || {})
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label} ×${n}`)
    .join(' · ');
  summary.textContent = preview.count
    ? `${preview.count} matching transaction${preview.count === 1 ? '' : 's'} in the last 12 months — ${byLabel}`
    : 'No matching transactions in the last 12 months.';
  el.appendChild(summary);
  if (!preview.count) return;

  const table = document.createElement('table');
  const tbody = table.createTBody();
  for (const m of preview.matches) {
    const row = tbody.insertRow();
    row.insertCell().textContent = m.date;
    const mCell = row.insertCell();
    mCell.textContent = m.merchant + (m.description && m.description !== m.merchant ? ` — ${m.description}` : '');
    const aCell = row.insertCell();
    aCell.className = 'col-amount';
    aCell.textContent = transactionMoney(m.amount, m.currency);
    row.insertCell().textContent = m.label;
  }
  if (preview.count > preview.matches.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = 'preview-summary';
    cell.textContent = `… and ${preview.count - preview.matches.length} more`;
  }
  el.appendChild(table);
}

async function applyRuleFromModal() {
  const pattern = $('rule-pattern').value;
  const name = $('rule-category').value;
  if (!pattern.trim() || !name) return;
  $('rule-status').textContent = 'Adding rule…';
  try {
    const res = await fetch('/api/rules/pattern', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pattern }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Failed to add the rule (${res.status})`);
    rulesDocCache = body;
    $('rule-modal').close();
    await reloadAfterClassificationChange();
  } catch (err) {
    $('rule-status').textContent = err.message;
  }
}

/* ---------- settings page ---------- */

// Every category is one entry in a single ordered list. The two checkboxes are
// what used to be the hard-coded transferPatterns/investments/renovations/taxes
// split; order is precedence, first match wins.
const CATEGORY_FLAGS = [
  { key: 'excludeFromSpending', label: 'Exclude from spending',
    title: 'Keep out of spending totals and the category donuts' },
  { key: 'tracker', label: 'Show a chart',
    title: 'Give this category its own tiles, chart and table on the dashboard' },
];

let settingsDoc = null; // last state loaded from the server (for revert)

async function renderSettings() {
  $('dashboard').hidden = true;
  $('detail').hidden = true;
  $('settings').hidden = false;
  $('settings-err').textContent = '';
  $('settings-status').textContent = '';
  window.scrollTo(0, 0);
  try {
    settingsDoc = await fetchRulesDoc(true);
    buildSettingsDom(settingsDoc);
  } catch (err) {
    $('settings-err').textContent = err.message;
  }
  renderAiUsage();
  renderApiKeys();
  renderAccount();
}

/**
 * Who is signed in, and whether the AI review is switched on for them. Called at
 * boot and again whenever a key is saved, since adding an OpenAI key is what
 * turns the review on — the page should not need reloading to notice.
 */
async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    const me = await res.json();
    const was = aiReview;
    aiReview = me.aiReview !== false;
    if (aiReview !== was) repaintAiCells();
    syncAiCards();
    return me;
  } catch (_err) {
    return null; // the app works either way; the AI controls just stay as they are
  }
}

// The two settings cards that only mean something with a key: the spend total
// (which would be a column of zeros) and the review settings, which are still
// worth showing — they are what the review starts from the day a key is added.
function syncAiCards() {
  $('ai-usage-card').hidden = !aiReview;
  $('ai-review-off').hidden = aiReview;
  // A per-transaction price for reviews that are not running reads as a charge
  // somebody is paying. The note above it already says what the state is.
  $('ai-settings-estimate').hidden = !aiReview;
}

// Whose account the destructive buttons below act on — worth stating plainly
// next to a delete button, especially with more than one Google account around.
async function renderAccount() {
  const me = await loadMe();
  if (!me) return; // the buttons work regardless of who we say you are
  $('account-email').textContent = me.email || 'this account';
  // Only operators get told the panel is there; for everyone else the link
  // stays hidden and /admin answers 404 anyway.
  $('admin-link').hidden = !me.admin;
}

/**
 * Show which keys are on file (never the values) and clear any stale input.
 *
 * `keepStatus` is for the calls that follow a save or a removal: those have just
 * written the outcome into the same line, and wiping it a moment later left the
 * card looking like nothing had happened.
 */
async function renderApiKeys({ keepStatus = false } = {}) {
  try {
    const res = await fetch('/api/keys');
    if (!res.ok) return;
    const k = await res.json();
    for (const [field, present] of [['key-lunchflow', k.lunchflow], ['key-openai', k.openai]]) {
      const input = $(field);
      input.value = '';
      input.placeholder = present ? '•••• stored — enter to replace' : 'not set';
    }
    $('key-openai-clear').hidden = !k.openai;
    if (!keepStatus) $('keys-status').textContent = '';
  } catch (_err) { /* keys card is best-effort */ }
}

async function saveKeys() {
  const status = $('keys-status');
  const lunchflow = $('key-lunchflow').value.trim();
  const openai = $('key-openai').value.trim();
  if (!lunchflow && !openai) {
    status.textContent = 'Enter a new key to update';
    return;
  }
  $('keys-save').disabled = true;
  status.textContent = 'Validating…';
  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only send fields the user actually changed.
      body: JSON.stringify({
        ...(lunchflow ? { lunchflow } : {}),
        ...(openai ? { openai } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Update failed (${res.status})`);
    status.textContent = 'Updated ✓';
    renderApiKeys({ keepStatus: true });
    // An OpenAI key added here switches the review on; the page should show that
    // straight away rather than at the next reload.
    loadMe().then(() => {
      if (aiReview) startAiSweep();
    });
  } catch (err) {
    status.textContent = err.message;
  } finally {
    $('keys-save').disabled = false;
  }
}

/**
 * Take the OpenAI key off the account, switching the AI review off. Confirmed,
 * because it is the only key operation that cannot be undone by retyping what
 * you had — but not destructive: reviews already paid for stay where they are.
 */
async function clearOpenAiKey() {
  if (!confirm('Remove your OpenAI key?\n\nThe AI review stops: no new reviews, no outlier '
    + 'flagging, and nothing more sent to a model. Reviews you have already paid for are kept, and '
    + 'adding a key again switches it back on.')) return;
  const status = $('keys-status');
  $('key-openai-clear').disabled = true;
  status.textContent = 'Removing…';
  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openai: null }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Removal failed (${res.status})`);
    status.textContent = 'Removed ✓';
    renderApiKeys({ keepStatus: true });
    loadMe();
  } catch (err) {
    status.textContent = err.message;
  } finally {
    $('key-openai-clear').disabled = false;
  }
}

const usd = (n) => '$' + Number(n).toFixed(n > 0 && n < 0.1 ? 4 : 2);

// The expected cost of one review, from the server (the same figures setup
// prices its estimate with). Kept so the note can follow the web-search box
// without refetching.
let aiCostBasis = null;

/**
 * What the AI settings above it come to per transaction. Deliberately a rate
 * rather than a total: unlike setup, this page cannot know how many
 * transactions a change would newly bring into range without pulling a year of
 * data, and the running total from real usage is one card above anyway.
 */
function renderAiSettingsEstimate() {
  const el = $('ai-settings-estimate');
  if (!el || !aiCostBasis) return;
  const cents = (n) => `${(n * 100).toFixed(n * 100 < 1 ? 2 : 1)}¢`;
  const withSearch = aiCostBasis.tokensPerReviewUsd + aiCostBasis.webSearchPerReviewUsd;
  const on = $('settings-ai-websearch').checked;
  el.textContent = `Estimated at ${cents(on ? withSearch : aiCostBasis.tokensPerReviewUsd)} per `
    + `transaction reviewed with the current settings — ${cents(withSearch)} with the merchant lookup `
    + `on, ${cents(aiCostBasis.tokensPerReviewUsd)} with it off. Reviews already computed are not `
    + 'recharged; the card above is what has actually been spent.';
}

async function renderAiUsage() {
  try {
    const res = await fetch('/api/ai-usage');
    if (!res.ok) return;
    const u = await res.json();
    if (u.estimate) {
      aiCostBasis = u.estimate;
      renderAiSettingsEstimate();
    }
    const tiles = $('ai-usage-tiles');
    tiles.textContent = '';
    for (const [label, value, sub] of [
      ['Total spent', usd(u.costUsd), 'tokens and tool calls together, ever'],
      ['Reviews computed', u.totalReviews, `${u.calls} API calls incl. tool round-trips`],
      ['Average per transaction', usd(u.avgPerReviewUsd), 'total spend ÷ reviews'],
      ['Web searches', u.webSearches, 'billed inside the total'],
    ]) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      for (const [cls, text] of [['label', label], ['value', String(value)], ['sub', sub]]) {
        const d = document.createElement('div');
        d.className = cls;
        d.textContent = text;
        tile.appendChild(d);
      }
      tiles.appendChild(tile);
    }
    $('ai-usage-note').textContent = `One figure covering tokens and tool calls, estimated at ${u.model} prices: `
      + `$${u.prices.inputPerMTok}/M input, $${u.prices.cachedInputPerMTok}/M cached input, `
      + `$${u.prices.outputPerMTok}/M output, $${u.prices.webSearchPerKCalls}/1k web searches `
      + `(override via OPENAI_PRICE_* env vars).`;
    $('ai-usage-tokens').textContent = `${u.inputTokens.toLocaleString()} input tokens `
      + `(${u.cachedInputTokens.toLocaleString()} cached) · ${u.outputTokens.toLocaleString()} output tokens `
      + `· ${u.webSearches.toLocaleString()} web searches · ${u.functionCalls.toLocaleString()} rule previews (free)`;
  } catch (_err) { /* usage is informational */ }
}

// Shared by the settings card and the delete dialog, which needs to know
// whether the download actually happened before it unlocks the rest.
async function exportAllData(btnId = 'data-export-btn', statusId = 'data-export-status') {
  const btn = $(btnId);
  const status = $(statusId);
  btn.disabled = true;
  status.textContent = 'Preparing…';
  try {
    const res = await fetch('/api/export');
    if (res.status === 401) return (location.href = '/login'), false;
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tallyhouse-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    status.textContent = 'Downloaded ✓';
    return true;
  } catch (err) {
    status.textContent = err.message;
    return false;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- account deletion ---------- */

// Whether this visit to the dialog has downloaded an export. Deliberately not
// persisted: an export from last week does not describe what is about to be
// destroyed, so each attempt earns its own copy.
let deleteExported = false;

function syncDeleteDialog() {
  const typed = $('delete-confirm').value.trim() === 'DELETE';
  $('delete-step-2').classList.toggle('is-locked', !deleteExported);
  $('delete-confirm').disabled = !deleteExported;
  $('delete-apply').disabled = !(deleteExported && typed);
}

function openDeleteDialog() {
  deleteExported = false;
  $('delete-confirm').value = '';
  $('delete-export-status').textContent = '';
  $('delete-status').textContent = '';
  $('delete-step-1').classList.remove('is-done');
  syncDeleteDialog();
  $('delete-modal').showModal();
}

async function deleteAccount() {
  const btn = $('delete-apply');
  btn.disabled = true;
  $('delete-status').textContent = 'Deleting…';
  try {
    const res = await fetch('/api/account/delete', { method: 'POST' });
    if (res.status === 401) return (location.href = '/login');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Delete failed (${res.status})`);
    }
    // Nothing left to render, and the session is gone — leave immediately
    // rather than let the page fire more requests as a signed-out user.
    location.href = '/login';
  } catch (err) {
    $('delete-status').textContent = err.message;
    btn.disabled = false;
  }
}

function patternsTextarea(patterns) {
  const ta = document.createElement('textarea');
  ta.className = 'rule-patterns';
  ta.spellcheck = false;
  ta.value = patterns.join('\n');
  ta.rows = Math.min(Math.max(patterns.length + 1, 2), 12);
  return ta;
}

function entryPreviewButton(getPatterns, previewEl) {
  return aiControl('button', 'Preview matches', 'ai-btn', null, async () => {
    const patterns = getPatterns();
    if (!patterns.length) {
      previewEl.textContent = '';
      return;
    }
    previewEl.textContent = 'Checking…';
    try {
      const res = await fetch('/api/rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patterns }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      renderPreviewInto(previewEl, await res.json());
    } catch (err) {
      previewEl.textContent = err.name === 'TimeoutError' ? 'Preview timed out — click to retry' : err.message;
    }
  });
}

const textareaPatterns = (ta) =>
  ta.value.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());

function buildSettingsDom(doc) {
  // The list comes from the server, so this settles a moment after the rest of
  // the form. collectSettings() falls back to the stored currency until it does,
  // so a save in that gap keeps the current one rather than blanking it.
  fillCurrencySelect($('settings-currency'), doc.currency)
    .catch((err) => { $('settings-err').textContent = err.message; });
  // Blank means "use the server default", which is what omitting the field does.
  $('settings-concurrency').value = doc.openaiConcurrency || '';
  $('settings-concurrency').placeholder = doc.openaiConcurrencyDefault || 2;
  $('settings-ai-months').value = doc.aiMonths || '';
  $('settings-ai-months').placeholder = doc.aiMonthsDefault || 12;
  $('settings-ai-months').max = doc.aiMonthsMax || 24;
  // A checkbox has no "unset", so an account that has never chosen is shown the
  // deployment default — which is what it is currently getting.
  $('settings-ai-websearch').checked = typeof doc.aiWebSearch === 'boolean'
    ? doc.aiWebSearch
    : doc.aiWebSearchDefault !== false;
  renderAiSettingsEstimate();
  const wrap = $('settings-groups');
  wrap.textContent = '';

  const card = document.createElement('section');
  card.className = 'card settings-group';
  const h = document.createElement('h2');
  h.textContent = 'Categories';
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'Checked top to bottom; the first matching category wins. Unmatched spending is "Other". '
    + 'Tick "Exclude from spending" for buckets like transfers or taxes, and "Show a chart" to give one '
    + 'its own section on the dashboard.';
  card.append(h, sub);

  const list = document.createElement('div');
  list.className = 'rule-entries';
  for (const cat of doc.categories) list.appendChild(ruleEntryDom(cat));
  card.appendChild(list);

  const add = aiControl('button', '+ Add category', 'ai-btn', null, () => {
    list.appendChild(ruleEntryDom({ id: '', name: '', patterns: [] }));
    list.lastChild.querySelector('.rule-name').focus();
  });
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  actions.appendChild(add);
  card.appendChild(actions);
  wrap.appendChild(card);
}

function ruleEntryDom(cat) {
  const el = document.createElement('div');
  el.className = 'rule-entry';
  // Blank for a brand-new category: the server slugs one from the name. Kept on
  // the element so renaming never breaks the overrides pinned to this category.
  el.dataset.id = cat.id || '';
  if (cat.autoTransfers) el.dataset.autoTransfers = '1';
  if (cat.excludeFromChart) el.dataset.excludeFromChart = '1';

  const head = document.createElement('div');
  head.className = 'rule-entry-head';
  const name = document.createElement('input');
  name.className = 'rule-name';
  name.placeholder = 'Category';
  name.value = cat.name;
  const preview = document.createElement('div');
  preview.className = 'rule-preview';
  const ta = patternsTextarea(cat.patterns);
  const remove = aiControl('button', 'Remove', 'ai-btn ghost',
    'Delete this category and its rules', () => el.remove());
  head.append(name, entryPreviewButton(() => textareaPatterns(ta), preview), remove);

  const flags = document.createElement('div');
  flags.className = 'rule-flags';
  const boxes = {};
  for (const flag of CATEGORY_FLAGS) {
    const label = document.createElement('label');
    label.title = flag.title;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = `flag-${flag.key}`;
    box.checked = Boolean(cat[flag.key]);
    boxes[flag.key] = box;
    label.append(box, document.createTextNode(' ' + flag.label));
    flags.appendChild(label);
  }

  // Excluded from spending with no tracker means the money leaves every total
  // and chart with no section anywhere to show it — right for internal
  // transfers, almost never what you want for a real category.
  const warn = document.createElement('span');
  warn.className = 'flag-warning';
  const syncWarning = () => {
    const hidden = boxes.excludeFromSpending.checked && !boxes.tracker.checked && !cat.autoTransfers;
    warn.textContent = hidden ? 'hidden everywhere — tick "Show a chart" to keep it visible' : '';
  };
  for (const box of Object.values(boxes)) box.addEventListener('change', syncWarning);
  syncWarning();
  flags.appendChild(warn);

  el.append(head, flags, ta, preview);
  return el;
}

// The DOM is the source of truth while editing; serialize it for PUT.
function collectSettings() {
  const doc = {
    currency: $('settings-currency').value || (settingsDoc && settingsDoc.currency) || 'GBP',
    categories: [],
  };
  const concurrency = Number($('settings-concurrency').value);
  if (Number.isInteger(concurrency) && concurrency >= 1) doc.openaiConcurrency = concurrency;
  // Blank keeps following the server default; a number is a choice this account
  // has made and stops moving if the deployment default ever changes.
  const aiMonths = Number($('settings-ai-months').value);
  if (Number.isInteger(aiMonths) && aiMonths >= 1) doc.aiMonths = aiMonths;
  doc.aiWebSearch = $('settings-ai-websearch').checked;
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
  const taken = new Set();
  for (const entry of document.querySelectorAll('.settings-group .rule-entry')) {
    const name = entry.querySelector('.rule-name').value.trim();
    let id = entry.dataset.id;
    if (!id) {
      id = slug(name);
      for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;
    }
    taken.add(id);
    const cat = {
      id,
      name,
      patterns: textareaPatterns(entry.querySelector('textarea')),
      excludeFromSpending: entry.querySelector('.flag-excludeFromSpending').checked,
      tracker: entry.querySelector('.flag-tracker').checked,
    };
    // Flags with no checkbox are preserved rather than silently dropped.
    if (entry.dataset.autoTransfers) cat.autoTransfers = true;
    if (entry.dataset.excludeFromChart) cat.excludeFromChart = true;
    doc.categories.push(cat);
  }
  return doc;
}

async function saveSettings() {
  $('settings-err').textContent = '';
  $('settings-status').textContent = 'Saving…';
  try {
    const res = await fetch('/api/rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettings()),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
    settingsDoc = body;
    rulesDocCache = body;
    $('settings-status').textContent = 'Saved ✓ — classifications recomputed';
    dashboardDirty = true;
    detailData = null;
    globalSearchData = null;
  } catch (err) {
    $('settings-status').textContent = '';
    $('settings-err').textContent = err.message;
  }
}

/* ---------- miscategorization review ---------- */

// All transactions that already have a category (not "Other") but whose cached
// AI review suggests a different one — biggest amounts first, so the mistakes
// that distort the charts most get fixed first. Uses cached reviews only; no
// model calls.
async function renderMiscat() {
  $('dashboard').hidden = true;
  $('settings').hidden = true;
  $('detail').hidden = false;
  $('detail-err').textContent = '';
  $('detail-pie-card').hidden = true;
  $('detail-providers-card').hidden = true;
  $('detail-filter').hidden = true;
  $('detail-search-form').hidden = true;
  $('detail-title').textContent = 'Miscategorized?';
  window.scrollTo(0, 0);

  try {
    if (!detailData || detailData.key !== 'miscat') {
      $('detail-list').textContent = '';
      $('detail-sub').textContent = 'Loading…';
      const res = await fetch('/api/transactions?range=year');
      if (res.status === 401) return (location.href = '/login');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      detailData = { key: 'miscat', currency: data.currency, transactions: data.transactions };
    }
    await fetchRulesDoc().catch(() => {});
    const txns = detailData.transactions;
    await loadCachedReviews(txns);

    const miscat = txns.filter((t) => {
      if (!aiEligible(t)) return false;
      if (!t.label || t.label === 'Other') return false;
      const r = aiReviews.get(String(t.id));
      return r && !r.error && r !== 'loading' &&
        r.assessment === 'wrong_category' && r.suggestedCategory && r.suggestedCategory !== t.label;
    });

    txSort = { key: 'amount', dir: 'desc' }; // the ask: biggest first
    detailFilteredTransactions = miscat;
    $('detail-list-title').textContent = 'Transactions GPT would re-categorize';
    $('detail-sub').textContent = `${miscat.length} transaction${miscat.length === 1 ? '' : 's'} · based on cached AI reviews · click the suggestion to accept it`;
    renderTxTable($('detail-list'), miscat);
  } catch (err) {
    $('detail-sub').textContent = '';
    $('detail-err').textContent = err.message;
  }
}

/* ---------- per-provider breakdown on the year view ---------- */

// Card statements append per-order references after an asterisk
// ("Amazon Prime*NO26409D4"); group by the stable merchant part.
function providerKey(merchant) {
  return String(merchant || '—').toLowerCase().split('*')[0].replace(/\s+/g, ' ').trim() || '—';
}

// On "last 12 months + category" views, recurring providers matter more than
// individual payments: show who they are and what they average per month.
function renderProviderBreakdown(list) {
  const card = $('detail-providers-card');
  if (!list || !list.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('detail-providers-title').textContent = `${view.category} by provider`;

  const groups = new Map();
  for (const t of list) {
    const key = providerKey(t.merchant);
    if (!groups.has(key)) groups.set(key, { name: String(t.merchant || '—').split('*')[0].trim(), total: 0, count: 0 });
    const g = groups.get(key);
    g.total += -t.baseAmount;
    g.count++;
  }
  const rows = [...groups.values()].sort((a, b) => b.total - a.total);
  const grandTotal = rows.reduce((s, g) => s + g.total, 0);

  const table = $('detail-providers-table');
  table.textContent = '';
  const head = table.createTHead().insertRow();
  for (const h of ['Provider', 'Payments', 'Monthly avg', 'Last 12 months']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const g of rows) {
    const row = body.insertRow();
    row.insertCell().textContent = g.name;
    row.insertCell().textContent = g.count;
    row.insertCell().textContent = money(g.total / 12);
    row.insertCell().textContent = money(g.total);
  }
  const totalRow = body.insertRow();
  totalRow.className = 'providers-total';
  totalRow.insertCell().textContent = 'All providers';
  totalRow.insertCell().textContent = list.length;
  totalRow.insertCell().textContent = money(grandTotal / 12);
  totalRow.insertCell().textContent = money(grandTotal);
}

/* ---------- events ---------- */

$('detail-back').addEventListener('click', () => (location.hash = ''));
$('global-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runGlobalSearch();
});
$('global-search-clear').addEventListener('click', () => {
  clearSearch('global');
  runGlobalSearch();
});
$('global-search-download').addEventListener('click', () => {
  downloadRawTransactions(globalSearchResults, 'transactions-search.json');
});
$('detail-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  renderDetailBody();
});
$('detail-search-clear').addEventListener('click', () => {
  clearSearch('detail');
  renderDetailBody();
});
$('detail-search-download').addEventListener('click', () => {
  const scope = view.scope === 'year' ? 'last-12-months' : view.month;
  downloadRawTransactions(detailFilteredTransactions, `transactions-${scope}.json`);
});
$('miscat-btn').addEventListener('click', () => go('#/miscat'));
$('settings-btn').addEventListener('click', () => go('#/settings'));
$('settings-back').addEventListener('click', () => (location.hash = ''));
$('settings-save').addEventListener('click', saveSettings);
$('settings-ai-websearch').addEventListener('change', renderAiSettingsEstimate);
$('settings-revert').addEventListener('click', () => {
  if (settingsDoc) buildSettingsDom(settingsDoc);
  $('settings-status').textContent = 'Edits discarded';
  $('settings-err').textContent = '';
});
$('data-export-btn').addEventListener('click', () => exportAllData());
$('account-logout').addEventListener('click', () => $('logout').click());
$('account-delete').addEventListener('click', openDeleteDialog);
$('delete-export').addEventListener('click', async () => {
  if (await exportAllData('delete-export', 'delete-export-status')) {
    deleteExported = true;
    $('delete-step-1').classList.add('is-done');
    syncDeleteDialog();
    $('delete-confirm').focus();
  }
});
$('delete-confirm').addEventListener('input', syncDeleteDialog);
$('delete-apply').addEventListener('click', deleteAccount);
$('delete-cancel').addEventListener('click', () => $('delete-modal').close());
$('keys-save').addEventListener('click', saveKeys);
$('key-openai-clear').addEventListener('click', clearOpenAiKey);
$('rule-apply').addEventListener('click', applyRuleFromModal);
$('rule-cancel').addEventListener('click', () => $('rule-modal').close());
$('rule-pattern').addEventListener('input', scheduleRulePreview);
$('refresh').addEventListener('click', () => load(true));
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});
window.addEventListener('hashchange', route);

// Dark mode is its own validated palette — re-read tokens and re-render on switch.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (view) renderDetail();
  else if (summary) render();
});

Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
Chart.defaults.font.size = 12;

load().then(route);
fetchRulesDoc().catch(() => {}); // warm the category list for the AI dropdowns
// Who we are first, because it says whether there is an AI review to start at
// all — an account with no OpenAI key should not fire a request whose only
// answer is 503.
loadMe().then(() => {
  if (aiReview) startAiSweep(); // review anything not yet cached, in the background
});

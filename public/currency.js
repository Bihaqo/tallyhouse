'use strict';

// The currency picker, shared by setup and settings — two pages that have to
// offer the same list and format money the same way, so the list is fetched
// from the server rather than written out twice in HTML.

// The symbol the browser uses for a currency, pulled out of a formatted zero.
// Falls back to the code itself for anything the browser has no symbol for,
// which is the right label anyway.
function currencySymbol(code) {
  try {
    return Number(0)
      .toLocaleString(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .replace(/[\d\s., ]/g, '') || code;
  } catch (_err) {
    return code;
  }
}

// An amount in `code`, as the dashboard shows it. dp of 0 is the tile/table
// style; 2 is used where individual transactions are listed.
function formatMoney(amount, code, dp = 0) {
  try {
    return Number(amount).toLocaleString('en-GB', {
      style: 'currency',
      currency: code || 'GBP',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  } catch (_err) {
    return `${code || ''} ${Number(amount).toFixed(dp)}`.trim();
  }
}

let listPromise = null;

// The supported currencies and the one to fall back on, fetched once per page.
function currencyList() {
  if (!listPromise) {
    listPromise = fetch('/api/currencies')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Failed to load currencies (${res.status})`))))
      .catch((err) => {
        listPromise = null; // so a later attempt can retry rather than reuse the failure
        throw err;
      });
  }
  return listPromise;
}

// Fill a <select> with the supported currencies and preselect `selected`, or
// the shipped default when there is nothing to preselect. Never leaves the
// first option selected by accident — that is alphabetical, not a choice.
async function fillCurrencySelect(select, selected) {
  const body = await currencyList();
  select.textContent = '';
  for (const entry of body.currencies || []) {
    const symbol = currencySymbol(entry.code);
    const label = symbol === entry.code
      ? `${entry.code} — ${entry.name}`
      : `${entry.code} — ${entry.name} (${symbol})`;
    select.appendChild(new Option(label, entry.code));
  }
  const has = (code) => [...select.options].some((o) => o.value === code);
  if (selected && has(selected)) select.value = selected;
  else if (has(body.default)) select.value = body.default;
  return select.value;
}

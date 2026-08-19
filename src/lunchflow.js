'use strict';

const BASE_URL = process.env.LUNCHFLOW_BASE_URL || 'https://www.lunchflow.app/api/v1';
const DEBUG = process.env.LUNCHFLOW_DEBUG === '1';

async function lf(apiKey, pathname, params) {
  const url = new URL(BASE_URL + pathname);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lunchflow ${pathname} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Lunchflow (like many REST APIs) may wrap list payloads in an envelope. Accept a
// bare array or any of the common wrapper keys so a shape change doesn't blank the
// dashboard. `keys` lists the likely names in priority order for this resource.
function unwrap(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const k of [...keys, 'data', 'results', 'items']) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    // Some APIs nest as { data: { transactions: [...] } }.
    if (payload.data && typeof payload.data === 'object') {
      for (const k of keys) if (Array.isArray(payload.data[k])) return payload.data[k];
    }
  }
  return [];
}

async function getAccounts(apiKey) {
  const payload = await lf(apiKey, '/accounts');
  const accounts = unwrap(payload, ['accounts']);
  if (DEBUG) {
    console.log(`[lunchflow] /accounts -> ${accounts.length} accounts;`,
      accounts.length ? 'keys: ' + Object.keys(accounts[0]).join(',') : 'top-level keys: ' + Object.keys(payload || {}).join(','));
  }
  return accounts;
}

// The API returns transactions in camelCase (accountId, isPending); the rest of
// the app works in snake_case, matching the mock data. Normalize here so there's
// one shape downstream.
function normalizeTx(t) {
  return {
    id: t.id,
    account_id: t.accountId ?? t.account_id,
    amount: t.amount,
    currency: t.currency,
    date: t.date,
    merchant: t.merchant,
    description: t.description,
    is_pending: t.isPending ?? t.is_pending ?? false,
    raw: t, // original API object, surfaced in the UI's transaction detail view
  };
}

async function getTransactions(apiKey, accountId, from, to) {
  const payload = await lf(apiKey, `/accounts/${accountId}/transactions`, {
    from,
    to,
    include_pending: 'false',
  });
  const raw = unwrap(payload, ['transactions']);
  if (DEBUG) {
    console.log(`[lunchflow] account ${accountId} transactions -> ${raw.length};`,
      raw.length ? 'keys: ' + Object.keys(raw[0]).join(',') : 'top-level keys: ' + Object.keys(payload || {}).join(','));
  }
  return raw.map(normalizeTx);
}

module.exports = { getAccounts, getTransactions };

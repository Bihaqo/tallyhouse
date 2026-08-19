#!/usr/bin/env node
'use strict';

// Dumps the raw shape of Lunchflow API responses so we can adapt the parser.
// Run:  LUNCHFLOW_API_KEY=lf_... node scripts/debug-api.js
// It prints top-level keys and a sample record; it does NOT print your API key.

// Same default as src/lunchflow.js, www included. This script exists to show
// what the API really returns, so it should hit exactly the URL the app does
// rather than a host that may redirect to it.
const BASE_URL = process.env.LUNCHFLOW_BASE_URL || 'https://www.lunchflow.app/api/v1';
const KEY = process.env.LUNCHFLOW_API_KEY;

if (!KEY) {
  console.error('Set LUNCHFLOW_API_KEY first.');
  process.exit(1);
}

async function get(pathname, params) {
  const url = new URL(BASE_URL + pathname);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

function describe(label, json, rawText) {
  console.log(`\n=== ${label} ===`);
  if (json == null) {
    console.log('  (non-JSON response)');
    console.log('  ', rawText.slice(0, 400));
    return;
  }
  if (Array.isArray(json)) {
    console.log(`  top-level: ARRAY of ${json.length}`);
    if (json[0]) console.log('  first item keys:', Object.keys(json[0]));
    console.log('  first item:', JSON.stringify(json[0], null, 2));
  } else if (typeof json === 'object') {
    console.log('  top-level keys:', Object.keys(json));
    for (const [k, v] of Object.entries(json)) {
      if (Array.isArray(v)) {
        console.log(`  "${k}": ARRAY of ${v.length}`);
        if (v[0]) {
          console.log(`     first item keys:`, Object.keys(v[0]));
          console.log('     first item:', JSON.stringify(v[0], null, 2));
        }
      } else {
        console.log(`  "${k}":`, JSON.stringify(v));
      }
    }
  }
}

(async () => {
  const iso = (d) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 11, 1);

  const accounts = await get('/accounts');
  console.log('GET /accounts ->', accounts.status);
  describe('/accounts', accounts.json, accounts.text);

  // Try to find an account id from whatever shape came back.
  const list = Array.isArray(accounts.json)
    ? accounts.json
    : accounts.json?.accounts || accounts.json?.data || accounts.json?.results || [];
  const first = list[0];
  if (!first) {
    console.log('\nNo accounts found — cannot test transactions.');
    return;
  }
  const id = first.id ?? first.account_id ?? first.uuid;
  console.log(`\nUsing account id: ${JSON.stringify(id)} (${first.name || ''})`);

  // Test transactions both with and without date params, to see if params matter.
  const txWith = await get(`/accounts/${id}/transactions`, { from: iso(from), to: iso(to) });
  console.log(`\nGET /accounts/${id}/transactions?from=${iso(from)}&to=${iso(to)} ->`, txWith.status);
  describe('transactions (with dates)', txWith.json, txWith.text);

  const txNo = await get(`/accounts/${id}/transactions`);
  console.log(`\nGET /accounts/${id}/transactions (no params) ->`, txNo.status);
  describe('transactions (no params)', txNo.json, txNo.text);
})().catch((e) => {
  console.error('debug failed:', e.message);
  process.exit(1);
});

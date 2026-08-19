'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const currencies = require('../src/currencies');
const fx = require('../src/fx');

test('every offered currency is one the rate source can quote', () => {
  // A currency the rate source cannot quote would give that account a blank for
  // every foreign transaction it holds, so the list and the fetcher have to
  // agree. Frankfurter serves the ECB reference set, and EUR is its own base.
  assert.ok(currencies.LIST.some((c) => c.code === 'EUR'));
  assert.ok(currencies.isSupported(fx.BASE_CURRENCY), 'including the fallback');
  for (const entry of currencies.LIST) {
    assert.match(entry.code, /^[A-Z]{3}$/, `${entry.code} is not a currency code`);
    assert.ok(entry.name && entry.name.trim(), `${entry.code} has no name for the dropdown`);
  }
  const codes = currencies.LIST.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length, 'no duplicates');
});

test('unsupported and malformed codes are rejected, case and space are not', () => {
  assert.equal(currencies.normalize(' eur '), 'EUR');
  assert.equal(currencies.normalize('GBP'), 'GBP');
  for (const bad of ['XYZ', 'BTC', '£', '', null, undefined, 7, {}]) {
    assert.equal(currencies.normalize(bad), null, String(bad));
  }
});

/* ---------- what setup suggests ---------- */

test('the suggested currency is the one most of the transactions are in', () => {
  const tx = (currency) => ({ currency });
  assert.equal(currencies.detect({
    txs: [tx('EUR'), tx('EUR'), tx('EUR'), tx('GBP'), tx('USD')],
  }), 'EUR');
});

// An account list can carry a currency for a card that is barely touched, while
// the transactions say where the money actually moves.
test('transactions outweigh the account list, which is only a fallback', () => {
  const txs = [{ currency: 'SEK' }, { currency: 'SEK' }];
  const accounts = [{ currency: 'USD' }, { currency: 'USD' }, { currency: 'USD' }];
  assert.equal(currencies.detect({ txs, accounts }), 'SEK');
  assert.equal(currencies.detect({ txs: [], accounts }), 'USD', 'a bank connected but not yet swept');
});

test('detection gives back nothing rather than a guess', () => {
  assert.equal(currencies.detect({}), null);
  assert.equal(currencies.detect({ txs: [{ currency: 'XYZ' }, { currency: null }] }), null,
    'a currency that cannot be converted into is not a currency to keep books in');
});

test('a tie resolves the same way every time', () => {
  const txs = [{ currency: 'USD' }, { currency: 'EUR' }];
  assert.equal(currencies.detect({ txs }), currencies.detect({ txs: [...txs].reverse() }));
});

/* ---------- reading the old display-only symbol ---------- */

test('legacy currency symbols resolve to a currency, or to nothing readable', () => {
  assert.equal(currencies.fromSymbol('£'), 'GBP');
  assert.equal(currencies.fromSymbol(' € '), 'EUR');
  assert.equal(currencies.fromSymbol('CHF'), 'CHF');
  assert.equal(currencies.fromSymbol('kr'), null, 'shared by four currencies');
  assert.equal(currencies.fromSymbol('anything'), null);
  assert.equal(currencies.fromSymbol(null), null);
});

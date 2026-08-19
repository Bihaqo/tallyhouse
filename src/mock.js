'use strict';

// Deterministic demo data shaped exactly like the Lunchflow API responses,
// used when MOCK_DATA=1 or no API key is configured.

let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

const ACCOUNTS = [
  { id: 1, name: 'Sam Revolut', institution_name: 'Revolut', provider: 'gocardless', currency: 'GBP', status: 'active' },
  { id: 2, name: 'Riley Revolut', institution_name: 'Revolut', provider: 'gocardless', currency: 'GBP', status: 'active' },
  { id: 3, name: 'Barclays Current', institution_name: 'Barclays', provider: 'gocardless', currency: 'GBP', status: 'active' },
];

const SPEND = [
  { merchant: 'Tesco Stores', lo: 15, hi: 90, perMonth: 6, accounts: [1, 2, 3] },
  { merchant: 'Sainsburys Local', lo: 8, hi: 45, perMonth: 4, accounts: [1, 2] },
  { merchant: 'Ocado Retail', lo: 60, hi: 140, perMonth: 2, accounts: [2] },
  { merchant: 'Pret A Manger', lo: 4, hi: 14, perMonth: 6, accounts: [1] },
  { merchant: 'Deliveroo', lo: 18, hi: 55, perMonth: 3, accounts: [1, 2] },
  { merchant: 'Nando\'s', lo: 25, hi: 60, perMonth: 1, accounts: [1] },
  { merchant: 'TfL Travel', lo: 2.8, hi: 8.1, perMonth: 16, accounts: [1, 2] },
  { merchant: 'Uber', lo: 9, hi: 32, perMonth: 3, accounts: [1, 2] },
  { merchant: 'Trainline', lo: 20, hi: 85, perMonth: 1, accounts: [1] },
  { merchant: 'Octopus Energy', lo: 110, hi: 190, perMonth: 1, accounts: [3] },
  { merchant: 'Thames Water', lo: 45, hi: 45, perMonth: 1, accounts: [3] },
  { merchant: 'Council Tax', lo: 172, hi: 172, perMonth: 1, accounts: [3] },
  { merchant: 'Vodafone', lo: 22, hi: 22, perMonth: 2, accounts: [1, 2] },
  { merchant: 'Netflix.com', lo: 12.99, hi: 12.99, perMonth: 1, accounts: [1] },
  { merchant: 'Spotify', lo: 11.99, hi: 11.99, perMonth: 1, accounts: [2] },
  { merchant: 'Amazon Marketplace', lo: 10, hi: 120, perMonth: 3, accounts: [1, 2] },
  { merchant: 'IKEA London', lo: 30, hi: 200, perMonth: 0.4, accounts: [2] },
  { merchant: 'Boots', lo: 8, hi: 35, perMonth: 1, accounts: [2] },
  { merchant: 'PureGym', lo: 24.99, hi: 24.99, perMonth: 1, accounts: [1] },
  { merchant: 'Airbnb', lo: 180, hi: 450, perMonth: 0.25, accounts: [1] },
  { merchant: 'ATM Withdrawal', lo: 20, hi: 100, perMonth: 1, accounts: [1, 3] },
  { merchant: 'The Coffee House', lo: 3, hi: 9, perMonth: 8, accounts: [1, 2] },
  // Intentionally unmatched by the default rules, so "Other" and the AI
  // review flow are exercisable with demo data.
  { merchant: 'Glide Micromobility', lo: 5, hi: 25, perMonth: 2, accounts: [1] },
  { merchant: 'Borough Wine Rooms', lo: 15, hi: 60, perMonth: 1, accounts: [2] },
  // Rare anomalously large charge from an otherwise-stable merchant, so the
  // outlier detection has something to flag in demo data.
  { merchant: 'Tesco Stores', lo: 780, hi: 920, perMonth: 0.5, accounts: [2] },
];

// Invented names on purpose: a real brokerage line-up here would be one
// person's actual portfolio shipped as everyone's demo data.
const INVESTMENTS = [
  { merchant: 'Coinvault Exchange', amount: 200, accounts: [1] },
  { merchant: 'Northgate Securities', amount: 500, accounts: [3] },
  { merchant: 'Highstreet Mortgage', amount: 1240, accounts: [3] },
  { merchant: 'Meridian Metals', amount: 150, accounts: [1], everyN: 3 },
];

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function generate() {
  const txs = [];
  let nextId = 1;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() - 12, 1);

  for (let m = new Date(start); m <= today; m.setMonth(m.getMonth() + 1)) {
    const y = m.getFullYear();
    const mo = m.getMonth();
    const monthIndex = (y - start.getFullYear()) * 12 + (mo - start.getMonth());
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const isCurrent = y === today.getFullYear() && mo === today.getMonth();
    const maxDay = isCurrent ? today.getDate() : daysInMonth;

    const dayFor = () => 1 + Math.floor(rand() * maxDay);
    const dateFor = (day) => iso(new Date(Date.UTC(y, mo, day)));

    // Salaries in
    txs.push({ id: String(nextId++), account_id: 3, amount: 4200, currency: 'GBP', date: dateFor(Math.min(25, maxDay)), merchant: 'ACME LTD SALARY', description: 'Salary', is_pending: false });
    txs.push({ id: String(nextId++), account_id: 2, amount: 3100, currency: 'GBP', date: dateFor(Math.min(28, maxDay)), merchant: 'GLOBEX PAYROLL', description: 'Salary', is_pending: false });

    // Everyday spending
    for (const s of SPEND) {
      const n = s.perMonth >= 1 ? s.perMonth : rand() < s.perMonth ? 1 : 0;
      for (let i = 0; i < n; i++) {
        if (rand() > 0.9) continue;
        const amount = -(s.lo + rand() * (s.hi - s.lo));
        txs.push({
          id: String(nextId++),
          account_id: pick(s.accounts),
          amount: Math.round(amount * 100) / 100,
          currency: 'GBP',
          date: dateFor(dayFor()),
          merchant: s.merchant,
          description: s.merchant,
          is_pending: false,
        });
      }
    }

    // Investments
    for (const inv of INVESTMENTS) {
      if (inv.everyN && monthIndex % inv.everyN !== 0) continue;
      const day = Math.min(5, maxDay);
      txs.push({
        id: String(nextId++),
        account_id: pick(inv.accounts),
        amount: -inv.amount,
        currency: 'GBP',
        date: dateFor(day),
        merchant: inv.merchant,
        description: `Payment to ${inv.merchant}`,
        is_pending: false,
      });
    }

    // Internal transfers: Barclays -> Sam Revolut, and Sam -> Riley
    const t1 = Math.min(2 + Math.floor(rand() * 5), maxDay);
    txs.push({ id: String(nextId++), account_id: 3, amount: -800, currency: 'GBP', date: dateFor(t1), merchant: 'Revolut', description: 'Transfer to Revolut', is_pending: false });
    txs.push({ id: String(nextId++), account_id: 1, amount: 800, currency: 'GBP', date: dateFor(Math.min(t1 + 1, maxDay)), merchant: 'Top-up', description: 'Top-up by bank transfer', is_pending: false });

    if (maxDay >= 10) {
      const amt = Math.round((200 + rand() * 300) * 100) / 100;
      txs.push({ id: String(nextId++), account_id: 1, amount: -amt, currency: 'GBP', date: dateFor(10), merchant: 'To Riley', description: 'Transfer to Riley', is_pending: false });
      txs.push({ id: String(nextId++), account_id: 2, amount: amt, currency: 'GBP', date: dateFor(10), merchant: 'From Sam', description: 'Transfer from Sam', is_pending: false });
    }
  }
  return txs;
}

// Signatures mirror src/lunchflow.js (leading apiKey) so summary.js can call
// either interchangeably; the mock ignores the key.
let cache = null;
function getAccounts(_apiKey) {
  return Promise.resolve(ACCOUNTS);
}
function getTransactions(_apiKey, accountId, from, to) {
  if (!cache) cache = generate();
  return Promise.resolve(
    cache.filter((t) => t.account_id === accountId && t.date >= from && t.date <= to)
  );
}

module.exports = { getAccounts, getTransactions };

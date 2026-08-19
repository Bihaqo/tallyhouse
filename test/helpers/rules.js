'use strict';

// A fabricated rules document for the tests.
//
// The shipped defaults (config/settings.json) deliberately carry no keyword
// patterns: patterns name the individuals and small businesses a household
// pays, so a real set committed to a public repository would publish one
// family's private life and hand it to every new user as a starting point.
// The engine still needs patterns to exercise, so tests use invented merchants.
//
// Every pattern here earns its place by covering a feature:
//   'own account'   plain substring
//   'exchanged to'  a second pattern in one category
//   'top-up by *'   trailing wildcard
//   '=quicktrain'   exact-name match, listed above the substring that overlaps it
//   'quicktrain'    plain substring, reached only when the exact one misses
//   'bp '           trailing space, i.e. whole-word matching
// and the flags cover excludeFromSpending, tracker, excludeFromChart and
// autoTransfers, alone and in combination.

const FIXTURE = {
  currency: 'GBP',
  categories: [
    { id: 'internal-transfers', name: 'Internal transfers',
      patterns: ['own account', 'exchanged to', 'top-up by *'],
      excludeFromSpending: true, tracker: false, autoTransfers: true },
    { id: 'investments', name: 'Investments', patterns: ['brokerbox'],
      excludeFromSpending: true, tracker: true },
    { id: 'renovation', name: 'Renovation', patterns: ['plasterfix'],
      excludeFromSpending: true, tracker: true },
    { id: 'taxes', name: 'Taxes', patterns: ['revenue office'],
      excludeFromSpending: true, tracker: true },
    { id: 'subscriptions', name: 'Subscriptions', patterns: ['streamly', '=quicktrain'],
      excludeFromSpending: false, tracker: false },
    { id: 'transport', name: 'Transport', patterns: ['quicktrain', 'bp '],
      excludeFromSpending: false, tracker: false },
    { id: 'groceries', name: 'Groceries', patterns: ['freshmart'],
      excludeFromSpending: false, tracker: false },
    { id: 'shopping', name: 'Shopping', patterns: ['ikea', 'flatpack'],
      excludeFromSpending: false, tracker: false },
    { id: 'home', name: 'Home', patterns: ['homestead furnishings'],
      excludeFromSpending: false, tracker: false },
    { id: 'travel', name: 'Travel', patterns: ['skyhop'],
      excludeFromSpending: false, tracker: false },
    { id: 'car', name: 'Car', patterns: ['motorworks'],
      excludeFromSpending: false, tracker: false, excludeFromChart: true },
  ],
};

// A fresh copy, so a test that mutates one does not leak into the next.
const fixtureRules = () => JSON.parse(JSON.stringify(FIXTURE));

module.exports = { fixtureRules, FIXTURE };

'use strict';

// The account cap and the waiting list it feeds.
//
// Deliberately written so nothing depends on how many rows the shared test
// database already holds: the assertions drive MAX_USERS to either side of the
// current count rather than assuming a starting point. Test files run in
// parallel processes against one database, so a test that assumed "there are N
// users" would pass or fail depending on what else happened to be running.

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

let users = null;

test.before(async () => {
  if (!h.dbAvailable) return;
  await h.initDb();
  users = require('../src/users');
});

// Each identity is unique, so these never collide with another file's rows.
const identity = (tag) => ({
  sub: `sub-${process.pid}-${tag}-${Date.now()}`,
  email: `cap-${process.pid}-${tag}-${Date.now()}@example.com`,
});

test('maxUsers defaults to 20, is overridable, and treats 0 as no limit', { skip }, () => {
  const original = process.env.MAX_USERS;
  try {
    delete process.env.MAX_USERS;
    assert.equal(users.maxUsers(), 20, 'the shipped default');
    process.env.MAX_USERS = '5';
    assert.equal(users.maxUsers(), 5);
    process.env.MAX_USERS = '0';
    assert.equal(users.maxUsers(), 0, '0 means uncapped');
    process.env.MAX_USERS = 'nonsense';
    assert.equal(users.maxUsers(), 0, 'an unparseable value fails open rather than locking everyone out');
  } finally {
    if (original === undefined) delete process.env.MAX_USERS;
    else process.env.MAX_USERS = original;
  }
});

// No database needed, so this one also runs in the offline `npm test`.
test('the signup log escalates as the cap approaches and is reached', () => {
  const { _internal } = require('../src/users');
  const seen = [];
  const [log, warn] = [console.log, console.warn];
  console.log = (line) => seen.push(['log', line]);
  console.warn = (line) => seen.push(['warn', line]);
  try {
    _internal.announceSignup(5, 20); // plenty of room
    _internal.announceSignup(16, 20); // 80% of 20
    _internal.announceSignup(20, 20); // full
    _internal.announceSignup(3, 0); // no cap configured
  } finally {
    console.log = log;
    console.warn = warn;
  }

  assert.deepEqual(seen.map(([level]) => level), ['log', 'warn', 'warn', 'log'],
    'only the interesting two are WARN, so they stand out in the deploy log');
  assert.match(seen[0][1], /\(5\/20\)/);
  assert.match(seen[1][1], /approaching/);
  assert.match(seen[2][1], /CAP REACHED/);
  assert.match(seen[3][1], /no cap set/);
});

test('a new account is created while there is room', { skip }, async () => {
  process.env.MAX_USERS = '0'; // uncapped, whatever the table already holds
  const who = identity('room');
  const user = await users.upsertByGoogle(who);
  assert.ok(user && user.id, 'a row comes back');
  assert.equal(user.email, who.email);
});

test('a new account is refused once the cap is reached', { skip }, async () => {
  // A cap of 1 against a table that already has users is always "full", which is
  // what makes this independent of the row count.
  process.env.MAX_USERS = '0';
  await users.upsertByGoogle(identity('occupant')); // guarantee at least one
  process.env.MAX_USERS = '1';
  try {
    const refused = await users.upsertByGoogle(identity('refused'));
    assert.equal(refused, null, 'null is how the cap says no');
  } finally {
    process.env.MAX_USERS = '0';
  }
});

test('an existing account still signs in when the cap is reached', { skip }, async () => {
  // The important one: a cap that locked out the people already using the app
  // would be worse than no cap at all.
  process.env.MAX_USERS = '0';
  const who = identity('returning');
  const created = await users.upsertByGoogle(who);
  assert.ok(created.id);

  process.env.MAX_USERS = '1';
  try {
    const again = await users.upsertByGoogle(who);
    assert.ok(again, 'not turned away');
    assert.equal(again.id, created.id, 'and it is the same account, not a new one');
  } finally {
    process.env.MAX_USERS = '0';
  }
});

test('a returning account picks up an email change at Google', { skip }, async () => {
  process.env.MAX_USERS = '0';
  const who = identity('renamed');
  const created = await users.upsertByGoogle(who);
  const moved = await users.upsertByGoogle({ sub: who.sub, email: `new-${who.email}` });
  assert.equal(moved.id, created.id);
  assert.equal(moved.email, `new-${who.email}`);
});

test('two sign-ins racing for the last place cannot both take it', { skip }, async () => {
  // The bug this guards is both callers passing the count check before either
  // inserts; an advisory lock around count-then-insert is what prevents it.
  //
  // Asserted as "at most one", not "exactly one", on purpose. Sizing the cap to
  // the current count is the only way to manufacture a single free place, but
  // another test file sharing this database may take that place first, in which
  // case both attempts are correctly refused. "At most one" is the property that
  // actually matters and it holds either way; "exactly one" would be a test that
  // fails on other people's traffic.
  process.env.MAX_USERS = '0';
  const base = await users.countUsers();
  process.env.MAX_USERS = String(base + 1);
  try {
    const results = await Promise.all([
      users.upsertByGoogle(identity('race-a')),
      users.upsertByGoogle(identity('race-b')),
    ]);
    const admitted = results.filter(Boolean);
    assert.ok(admitted.length <= 1, `at most one admitted, saw ${admitted.length}`);
    if (admitted.length) {
      assert.ok(await users.countUsers() <= base + 1, 'admitting one did not overshoot the cap');
    }
  } finally {
    process.env.MAX_USERS = '0';
  }
});

test('the waiting list records an address once', { skip }, async () => {
  const address = `wait-${process.pid}-${Date.now()}@example.com`;
  const first = await users.addToWaitlist(address);
  const second = await users.addToWaitlist(address);
  assert.equal(second, first, 'adding the same address twice does not grow the list');

  const { rows } = await h.query('SELECT count(*)::int AS n FROM waitlist WHERE email = $1', [address]);
  assert.equal(rows[0].n, 1);
});

test('the waiting list lowercases what it stores', { skip }, async () => {
  const address = `Mixed-${process.pid}-${Date.now()}@Example.com`;
  await users.addToWaitlist(address);
  const { rows } = await h.query('SELECT count(*)::int AS n FROM waitlist WHERE email = $1', [
    address.toLowerCase(),
  ]);
  assert.equal(rows[0].n, 1, 'stored lowercase, so it matches the users table convention');
});

test('atCapacity reflects the cap, not the traffic', { skip }, async () => {
  process.env.MAX_USERS = '0';
  await users.upsertByGoogle(identity('atcap')); // so the table is not empty
  assert.equal(await users.atCapacity(), false, 'uncapped is never full');
  process.env.MAX_USERS = '1';
  try {
    assert.equal(await users.atCapacity(), true);
  } finally {
    process.env.MAX_USERS = '0';
  }
});

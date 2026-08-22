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

// An account that occupies a place. Signing in no longer takes one — the cap
// counts accounts that finished setup — so a test that wants the instance to be
// full has to put somebody through setup, not just through the door.
async function occupant(tag) {
  const user = await users.upsertByGoogle(identity(tag));
  assert.ok(user, 'the occupant itself was admitted');
  assert.ok(await users.claimAccountPlace(user.id), 'and finished setup');
  return user;
}

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
  // A cap of 1 against a table that already holds a finished account is always
  // "full", which is what makes this independent of the row count.
  process.env.MAX_USERS = '0';
  await occupant('occupant'); // guarantee at least one place is taken
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

test('sign-ins arriving at a full instance are all refused', { skip }, async () => {
  // Sign-in no longer takes a place — the cap counts accounts that finished
  // setup — so this is no longer a race for the last one. What it still has to
  // do is turn people away at the door when there is visibly no room, rather
  // than letting them fill in a whole setup that cannot succeed. The race for
  // the last place is now at setup, and is tested there.
  process.env.MAX_USERS = '0';
  await occupant('door-occupant');
  process.env.MAX_USERS = '1'; // a table with a finished account is always full at 1
  try {
    const results = await Promise.all([
      users.upsertByGoogle(identity('door-a')),
      users.upsertByGoogle(identity('door-b')),
    ]);
    assert.deepEqual(results, [null, null], 'both told there is no room');
  } finally {
    process.env.MAX_USERS = '0';
  }
});

test('signing in while there is room does not reserve anything', { skip }, async () => {
  // Two people can hold rows against one free place. That is deliberate: rows
  // are free, places are not, and whoever finishes setup first gets it.
  process.env.MAX_USERS = '0';
  const base = await users.countUsers();
  process.env.MAX_USERS = String(base + 1);
  try {
    const both = await Promise.all([
      users.upsertByGoogle(identity('holder-a')),
      users.upsertByGoogle(identity('holder-b')),
    ]);
    assert.ok(both.every(Boolean), 'both get an account');
    assert.equal(await users.countUsers(), base, 'and the count has not moved');
  } finally {
    process.env.MAX_USERS = '0';
  }
});

/* ---------- what the cap counts ---------- */

test('signing in and never setting up takes no place', { skip }, async () => {
  // The point of the change: an abandoned sign-in costs this process nothing —
  // no cached pull, no sweep — so it must not refuse a real user on behalf of a
  // row that will never be used.
  process.env.MAX_USERS = '0';
  const before = await users.countUsers();
  const abandoned = await users.upsertByGoogle(identity('abandoned'));
  assert.ok(abandoned.id, 'the account row exists');
  assert.equal(await users.countUsers(), before, 'and counts for nothing');
  assert.equal(await users.atCapacity(), false);
});

test('finishing setup is what takes the place', { skip }, async () => {
  process.env.MAX_USERS = '0';
  const before = await users.countUsers();
  const user = await users.upsertByGoogle(identity('finisher'));
  assert.equal(await users.countUsers(), before);

  assert.equal(await users.claimAccountPlace(user.id), true);
  assert.equal(await users.countUsers(), before + 1, 'now it is one of them');
});

test('a full instance refuses the last step, not the account', { skip }, async () => {
  // Someone who signed in while there was room can reach the end of setup after
  // the last place has gone. The row survives, so they can finish later.
  process.env.MAX_USERS = '0';
  const waiting = await users.upsertByGoogle(identity('latecomer'));
  await occupant('takes-the-last-place');

  process.env.MAX_USERS = String(await users.countUsers());
  try {
    assert.equal(await users.claimAccountPlace(waiting.id), false, 'setup is refused');
    const row = await users.byId(waiting.id);
    assert.ok(row, 'but the account is still there');
    assert.equal(row.onboarded_at, null, 'simply unfinished');
  } finally {
    process.env.MAX_USERS = '0';
  }

  // And once there is room again, the same account finishes with no repeat of
  // anything it already did.
  assert.equal(await users.claimAccountPlace(waiting.id), true);
});

test('claiming a place twice is not a second place', { skip }, async () => {
  // Setup is a page that can be submitted twice. The second submission must not
  // be told the instance is full when this account is already in it.
  process.env.MAX_USERS = '0';
  const user = await users.upsertByGoogle(identity('twice'));
  assert.equal(await users.claimAccountPlace(user.id), true);
  const after = await users.countUsers();

  process.env.MAX_USERS = String(after); // exactly full
  try {
    assert.equal(await users.claimAccountPlace(user.id), true, 'already in, so still in');
    assert.equal(await users.countUsers(), after, 'and counted once');
  } finally {
    process.env.MAX_USERS = '0';
  }
});

test('two accounts finishing setup at once cannot both take the last place', { skip }, async () => {
  // The race that matters now. Both read "one place left" before either writes,
  // unless the count and the mark share a lock.
  process.env.MAX_USERS = '0';
  const a = await users.upsertByGoogle(identity('race-setup-a'));
  const b = await users.upsertByGoogle(identity('race-setup-b'));
  const base = await users.countUsers();
  process.env.MAX_USERS = String(base + 1);
  try {
    const results = await Promise.all([
      users.claimAccountPlace(a.id),
      users.claimAccountPlace(b.id),
    ]);
    assert.ok(results.filter(Boolean).length <= 1, `at most one, saw ${results.filter(Boolean).length}`);
    assert.ok(await users.countUsers() <= base + 1, 'and the cap was not overshot');
  } finally {
    process.env.MAX_USERS = '0';
  }
});

test('a demo account never occupies a place, even though it is onboarded', { skip }, async () => {
  // Demo accounts are created already set up, which is exactly the state the cap
  // now counts — so the exclusion has to survive this change.
  const demo = require('../src/demo');
  process.env.MAX_USERS = '0';
  const before = await users.countUsers();
  const created = await demo.create();
  try {
    assert.ok(created, 'a demo was made');
    assert.ok(created.onboarded_at, 'and it is onboarded');
    assert.equal(await users.countUsers(), before, 'and still counts for nothing');
  } finally {
    if (created) await demo.destroy(created.id);
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
  await occupant('atcap'); // so at least one place is taken
  assert.equal(await users.atCapacity(), false, 'uncapped is never full');
  process.env.MAX_USERS = '1';
  try {
    assert.equal(await users.atCapacity(), true);
  } finally {
    process.env.MAX_USERS = '0';
  }
});

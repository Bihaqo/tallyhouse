'use strict';

// Shared harness for the Postgres-backed tests. Point TEST_DATABASE_URL (or
// DATABASE_URL) at a throwaway database; the DB-dependent tests skip when it
// isn't set, so `npm test` still runs the pure-logic tests offline.
//
// Must be required BEFORE any src/ module, since src/db.js reads DATABASE_URL at
// load time.

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (url) {
  process.env.DATABASE_URL = url;
  if (!process.env.PGSSL) process.env.PGSSL = 'disable';
}

const dbAvailable = Boolean(url);
const skip = dbAvailable ? false : 'set TEST_DATABASE_URL to run the Postgres-backed tests';

let db = null;
let seq = 0;

async function initDb() {
  if (!dbAvailable) return null;
  db = require('../../src/db');
  await db.init();
  return db;
}

// A fresh, already-onboarded user so tests are isolated from each other.
async function freshUser() {
  const email = `test-${process.pid}-${++seq}-${Date.now()}@example.com`;
  const { rows } = await db.query(
    'INSERT INTO users (email, onboarded_at) VALUES ($1, now()) RETURNING id',
    [email]
  );
  return rows[0].id;
}

module.exports = {
  dbAvailable,
  skip,
  initDb,
  freshUser,
  query: (...args) => db.query(...args),
};

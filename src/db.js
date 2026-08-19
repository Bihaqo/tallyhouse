'use strict';

// The single Postgres connection pool for the app. Everything that persists
// state goes through here. DATABASE_URL is provided by Railway's Postgres
// plugin in production and points at the local dev cluster otherwise.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  const msg = 'DATABASE_URL is not set — the app needs a Postgres database';
  if (IS_PROD) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`${msg}. Defaulting to postgresql://localhost:5432/tallyhouse for dev.`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/tallyhouse',
  // Railway's managed Postgres terminates TLS but with a self-signed chain.
  ssl: process.env.PGSSL === 'disable' ? false
    : IS_PROD ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

pool.on('error', (err) => console.error('Unexpected Postgres pool error:', err.message));

function query(text, params) {
  return pool.query(text, params);
}

// Apply the schema (idempotent CREATE TABLE IF NOT EXISTS statements). Safe to
// run on every boot; doubles as the migration story until one is needed. An
// advisory lock serializes concurrent callers — CREATE TABLE IF NOT EXISTS is
// itself racy in Postgres, so two instances (or test processes) booting at once
// would otherwise collide on pg_type.
const SCHEMA_LOCK_KEY = 727274;
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    await client.query(schema);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

function end() {
  return pool.end();
}

module.exports = { pool, query, init, end };

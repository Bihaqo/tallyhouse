'use strict';

// express-session store backed by the user_sessions table, replacing the old
// JSON file store so sessions survive deploys without depending on a mounted
// volume — and so multiple app instances can share them.

const session = require('express-session');
const db = require('./db');

// How long a session lasts. Exported because two other places need the same
// number: server.js sets it as the cookie maxAge, and the admin panel subtracts
// it from `expire` to recover when a session started (see src/admin.js).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = SESSION_TTL_MS;

function expiryOf(sess) {
  const cookieExpires = sess && sess.cookie && sess.cookie.expires;
  return cookieExpires ? new Date(cookieExpires) : new Date(Date.now() + DEFAULT_TTL_MS);
}

class PgSessionStore extends session.Store {
  constructor({ pruneIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    // Drop expired rows periodically; unref so it never holds the process open.
    this.timer = setInterval(() => this.prune(), pruneIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async get(sid, cb) {
    try {
      const { rows } = await db.query(
        'SELECT sess FROM user_sessions WHERE sid = $1 AND expire > now()',
        [sid]
      );
      cb(null, rows.length ? rows[0].sess : null);
    } catch (err) {
      cb(err);
    }
  }

  async set(sid, sess, cb) {
    try {
      await db.query(
        `INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, sess, expiryOf(sess)]
      );
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  async destroy(sid, cb) {
    try {
      await db.query('DELETE FROM user_sessions WHERE sid = $1', [sid]);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  // Touch only bumps the expiry, keeping the cookie alive on active sessions.
  async touch(sid, sess, cb) {
    try {
      await db.query('UPDATE user_sessions SET expire = $2 WHERE sid = $1', [sid, expiryOf(sess)]);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  async prune() {
    try {
      await db.query('DELETE FROM user_sessions WHERE expire <= now()');
    } catch (err) {
      console.error('Could not prune expired sessions:', err.message);
    }
  }
}

module.exports = { PgSessionStore, SESSION_TTL_MS };

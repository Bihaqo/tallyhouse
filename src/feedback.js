'use strict';

/**
 * Feedback people chose to send.
 *
 * The one place in this app where an operator reads something belonging to a
 * named account, and it works precisely because it is the opposite of the admin
 * panel next to it: that panel counts what the app already had to store and
 * names nobody (see src/admin.js), while a row here exists only because someone
 * typed a message and pressed send. Volunteered, not observed — which is what
 * makes reading it, and answering it, fair.
 *
 * The picture is a second, separate act of consent. It is taken in the browser,
 * shown back before anything is sent, and only uploaded if the box is ticked;
 * an untouched form sends the text alone. That matters more here than in most
 * apps, because a picture of this page is a picture of somebody's bank
 * balances, and it is only ever sent because they looked at it and decided it
 * was worth sending.
 */

const db = require('./db');

/**
 * The largest picture that will be stored.
 *
 * A full-page PNG of the dashboard measures around 300–600KB; three megabytes
 * is well clear of a tall page on a high-density screen and still small enough
 * that a handful of them cannot become the biggest thing in the database. The
 * request body limit for this route is set above it in server.js so an oversize
 * picture is refused with a sentence rather than by the parser.
 */
const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

// Long enough for a considered bug report, short enough that the column is not
// a place to paste a novel — or a data export.
const MAX_MESSAGE_LENGTH = 4000;
const MAX_PAGE_LENGTH = 200;

// The first eight bytes of every PNG. Checked because "the client said it was a
// PNG" is not a reason to store bytes and later hand them to a browser as one.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode the data: URL the browser produced, or throw with a public message.
 *
 * Deliberately strict about the prefix: this is the one field that arrives as
 * an opaque blob and is served back out with an image content type, so the only
 * thing worth accepting is exactly what the capture produces.
 */
function decodeScreenshot(dataUrl) {
  if (dataUrl == null) return null;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    const err = new Error('The attached picture is not a PNG');
    err.status = 400;
    throw err;
  }
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (!bytes.length || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    const err = new Error('The attached picture is not a PNG');
    err.status = 400;
    throw err;
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    const err = new Error('That picture is too large to send — try without it');
    err.status = 413;
    throw err;
  }
  return bytes;
}

/** Store one message. Returns the new row's id. */
async function add({ userId, fromDemo = false, message, page = null, screenshot = null }) {
  // Text, not "anything that can be turned into text". A number or an object
  // arriving here is a client sending the wrong field, and storing `42` as
  // somebody's considered feedback helps nobody.
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    const err = new Error('Write a message first');
    err.status = 400;
    throw err;
  }
  const bytes = decodeScreenshot(screenshot);
  const { rows } = await db.query(
    `INSERT INTO feedback (user_id, from_demo, message, page, screenshot)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      userId,
      Boolean(fromDemo),
      text.slice(0, MAX_MESSAGE_LENGTH),
      page ? String(page).slice(0, MAX_PAGE_LENGTH) : null,
      bytes,
    ]
  );
  // No mail transport here either, so the log is the notification: one line so
  // that something arriving is visible in the deploy log rather than only to
  // somebody who happens to open the panel.
  console.log(`Feedback received (#${rows[0].id}${bytes ? ', with a picture' : ''})`);
  return rows[0].id;
}

/**
 * Newest first, without the pictures.
 *
 * The bytes are left in the database and fetched one at a time by
 * `screenshotOf`, because a list that inlined them would be tens of megabytes
 * to render a page of text.
 */
async function list({ limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT f.id, f.message, f.page, f.from_demo AS "fromDemo", f.created_at AS "createdAt",
            (f.screenshot IS NOT NULL) AS "hasScreenshot",
            octet_length(f.screenshot) AS "screenshotBytes",
            -- A demo's address is a generated .invalid name that exists only
            -- because the column is NOT NULL UNIQUE. Showing it would put a
            -- meaningless identifier where an operator looks for a person, so
            -- the panel gets the same null /api/me gives the demo itself, and
            -- labels the row from from_demo instead.
            CASE WHEN f.from_demo THEN NULL ELSE u.email END AS email
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     ORDER BY f.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function screenshotOf(id) {
  const { rows } = await db.query('SELECT screenshot FROM feedback WHERE id = $1', [id]);
  return rows.length ? rows[0].screenshot : null;
}

async function remove(id) {
  const { rowCount } = await db.query('DELETE FROM feedback WHERE id = $1', [id]);
  return rowCount > 0;
}

// Everything one account sent, deleted with the account. Called from the
// account-deletion route rather than left to the foreign key — see the note on
// the table in schema.sql for why a demo being reaped must not do this.
async function forgetUser(userId) {
  const { rowCount } = await db.query('DELETE FROM feedback WHERE user_id = $1', [userId]);
  return rowCount;
}

async function count() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM feedback');
  return rows[0].n;
}

module.exports = {
  add, list, screenshotOf, remove, forgetUser, count, decodeScreenshot,
  MAX_SCREENSHOT_BYTES, MAX_MESSAGE_LENGTH,
};

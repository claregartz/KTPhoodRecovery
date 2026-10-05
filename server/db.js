// Database setup.
//
// SQLite stores the whole database in a single file (data/freedge.db).
// This module opens that file (creating it if needed), makes sure the
// `items` table exists, and exports the connection for the routes to use.

const path = require('node:path');
const Database = require('better-sqlite3');

// Units a person can choose when adding an item. The API rejects anything
// else, and the frontend builds its dropdown from this list (via /api/units)
// so the two can never get out of sync.
const UNITS = ['servings', 'items', 'containers', 'bags'];

// DB_PATH lets you point at a different file (e.g. for testing).
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freedge.db');
const db = new Database(dbPath);

// Timestamps are stored as ISO 8601 text in UTC, e.g. "2026-10-05T14:30:00Z",
// which JavaScript's `new Date(...)` understands directly.
//
// "Empty" is not its own column: an item is empty exactly when quantity = 0.
// That way the two can never disagree.
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    quantity    INTEGER NOT NULL CHECK (quantity >= 0),
    unit        TEXT    NOT NULL CHECK (unit IN (${UNITS.map((u) => `'${u}'`).join(', ')})),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    emptied_at  TEXT
  )
`);

module.exports = { db, UNITS };

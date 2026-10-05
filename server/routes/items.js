// The REST API for fridge items.
//
// Every route here is mounted under /api (see server/index.js), so
// router.get('/items') answers GET /api/items.
//
// All the inventory rules live in this file, on the server, so they apply
// no matter which phone or browser sends the request.

const express = require('express');
const { db, UNITS } = require('../db');

const router = express.Router();

// The SQL to stamp "right now" in the same format as the table defaults.
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// Prepared statements: SQL compiled once and reused. The `?` placeholders
// are filled in safely by the library, which prevents SQL injection
// (someone typing SQL code into the item name field).
const listItems = db.prepare(`
  SELECT * FROM items
  WHERE quantity > 0
  ORDER BY created_at DESC, id DESC
`);
const getItem = db.prepare('SELECT * FROM items WHERE id = ?');
const insertItem = db.prepare('INSERT INTO items (name, quantity, unit) VALUES (?, ?, ?)');

// Subtracting happens inside the database (quantity = quantity - ?), so if
// two people tap "Take" at the same moment, both subtractions count.
// `quantity >= ?` makes sure we never go below zero. When the result hits
// zero, emptied_at is stamped.
const takeFromItem = db.prepare(`
  UPDATE items
  SET quantity   = quantity - @amount,
      updated_at = ${NOW},
      emptied_at = CASE WHEN quantity - @amount = 0 THEN ${NOW} ELSE emptied_at END
  WHERE id = @id AND quantity >= @amount
`);

// Only touches items that aren't already empty, so emptied_at keeps the
// time the item first ran out.
const emptyItem = db.prepare(`
  UPDATE items
  SET quantity = 0, updated_at = ${NOW}, emptied_at = ${NOW}
  WHERE id = ? AND quantity > 0
`);

// --- helpers ---------------------------------------------------------------

// True for whole numbers >= min, e.g. isWholeNumber(3, 1) -> true,
// isWholeNumber(2.5, 1) -> false, isWholeNumber("3", 1) -> false.
function isWholeNumber(value, min) {
  return Number.isInteger(value) && value >= min;
}

// Turns the ":id" part of the URL into a number, or null if it isn't one.
function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// --- routes ----------------------------------------------------------------

// GET /api/units -> ["servings", "items", ...]
router.get('/units', (req, res) => {
  res.json(UNITS);
});

// GET /api/items -> every item that isn't empty, newest first
router.get('/items', (req, res) => {
  res.json(listItems.all());
});

// POST /api/items  body: { name, quantity, unit }
router.post('/items', (req, res) => {
  const { name, quantity, unit } = req.body ?? {};
  const trimmedName = typeof name === 'string' ? name.trim() : '';

  if (trimmedName.length < 1 || trimmedName.length > 100) {
    return res.status(400).json({ error: 'Name must be 1–100 characters.' });
  }
  if (!isWholeNumber(quantity, 1)) {
    return res.status(400).json({ error: 'Quantity must be a whole number of at least 1.' });
  }
  if (!UNITS.includes(unit)) {
    return res.status(400).json({ error: `Unit must be one of: ${UNITS.join(', ')}.` });
  }

  const result = insertItem.run(trimmedName, quantity, unit);
  // 201 Created, with the full new item (including its id and timestamps)
  res.status(201).json(getItem.get(result.lastInsertRowid));
});

// POST /api/items/:id/take  body: { amount }
router.post('/items/:id/take', (req, res) => {
  const id = parseId(req.params.id);
  const { amount } = req.body ?? {};

  if (!isWholeNumber(amount, 1)) {
    return res.status(400).json({ error: 'Amount must be a whole number of at least 1.' });
  }

  const result = takeFromItem.run({ id, amount });

  if (result.changes === 0) {
    // Nothing was updated. Work out why so the user gets a helpful message.
    const item = id && getItem.get(id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    if (item.quantity === 0) {
      return res.status(400).json({ error: `${item.name} is already empty.` });
    }
    return res.status(400).json({
      error: `Only ${item.quantity} ${item.unit} of ${item.name} left.`,
    });
  }

  res.json(getItem.get(id));
});

// POST /api/items/:id/empty
router.post('/items/:id/empty', (req, res) => {
  const id = parseId(req.params.id);
  const item = id && getItem.get(id);

  if (!item) {
    return res.status(404).json({ error: 'Item not found.' });
  }

  // If it's already empty this does nothing, which is fine: the end
  // result ("this item is empty") is what the user asked for.
  emptyItem.run(id);
  res.json(getItem.get(id));
});

module.exports = router;

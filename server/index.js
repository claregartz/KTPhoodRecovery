// Entry point: `npm start` runs this file.
//
// One Express server does two jobs:
//   1. Serves the frontend (the files in public/) to the browser.
//   2. Answers API requests under /api (defined in routes/items.js).

const path = require('node:path');
const express = require('express');
const itemsRouter = require('./routes/items');

const app = express();
// Hosting services tell the app which port to use via PORT.
const PORT = process.env.PORT || 3000;

// Parse JSON request bodies so routes can read req.body.
app.use(express.json());

// API routes.
app.use('/api', itemsRouter);

// Unknown /api paths get a JSON 404 instead of an HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Everything else: serve files from public/ (index.html, styles.css, app.js).
app.use(express.static(path.join(__dirname, '..', 'public')));

// Error handler: catches anything that went wrong above (e.g. invalid JSON
// in a request body) and replies with JSON instead of crashing.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`Freedge running at http://localhost:${PORT}`);
});

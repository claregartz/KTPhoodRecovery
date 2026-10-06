# KTPhoodRecovery

A mobile-first web app showing what's in the Cornell Food Recovery Network
community **freedge** (free fridge) right now. Built by KTP x FRN.

People currently coordinate over GroupMe, so anyone who hasn't checked the
chat doesn't know what's available. This app answers "what's in the freedge?"
at a glance and lets anyone keep that answer accurate.

**Contributors:**
- Charvi Kanna
- Clare Gartz
- Anya Dennison

---

## Contents

1. [What the app does](#what-the-app-does)
2. [Tech stack](#tech-stack)
3. [Running it locally](#running-it-locally)
4. [How it works (architecture)](#how-it-works-architecture)
5. [Project structure](#project-structure)
6. [API endpoints](#api-endpoints)
7. [Known limitations](#known-limitations)
8. [Team workflow and git guide](#team-workflow-and-git-guide)

---

## What the app does

- **See what's in the fridge:** a list of items and how much is left
  (e.g. "Lasagna: 10 servings · updated 5 min ago").
- **Add an item:** name, whole-number quantity, and a unit
  (`servings`, `items`, `containers`, or `bags`).
- **Take some:** "Take 1", or "Take…" to choose an amount. The quantity goes
  down by that many.
- **Mark empty:** for when the fridge doesn't match the app. Asks
  "are you sure?" first.
- **Empty items disappear:** when the quantity reaches 0 (by taking or by
  marking empty), the item is hidden from the list. It stays in the database
  with an `emptied_at` timestamp so history isn't lost.
- **Stays fresh:** the list refreshes every 30 seconds, whenever you
  return to the tab, and when you tap ⟳.

## Tech stack

| Tier | Technology | Why we chose it |
|---|---|---|
| Frontend (client) | Plain **HTML, CSS, JavaScript** | No framework or build step, so every line is readable. One page doesn't need React. |
| Application server (REST API) | **Node.js** + **Express** | JavaScript on the server too, so the whole app uses one language. Express is the most widely used, best-documented Node web library. |
| Database | **SQLite** (via `better-sqlite3`) | The whole database is one file: nothing to install and no account. It uses real SQL, so moving to Postgres later is a small change. |

## Running it locally

### 1. Install Node.js (one time)

Download the **LTS** version from <https://nodejs.org> (version 20 or newer).
Check that it worked:

```bash
node -v   # should print v20.x.x or higher
npm -v
```

### 2. Get the code (one time)

```bash
git clone https://github.com/claregartz/KTPhoodRecovery.git
cd KTPhoodRecovery
```

### 3. Install dependencies

```bash
npm install
```

This reads `package.json` and downloads Express and better-sqlite3 into
`node_modules/`. Run it again whenever `package.json` changes (for example,
after pulling a teammate's work).

### 4. Start the app

```bash
npm run dev     # restarts automatically when you save a server file
# or
npm start       # plain start, no auto-restart
```

Open <http://localhost:3000>. The database file `data/freedge.db` is
created automatically on first run.

**Try it on your phone:** with your phone on the same Wi-Fi as your laptop,
find your laptop's local IP (Mac: System Settings → Wi-Fi → Details) and open
`http://<that-ip>:3000` on your phone. Campus Wi-Fi (eduroam) may block this.
If it does, use your browser's mobile view instead (Chrome: right-click →
Inspect → phone icon).

**Reset your local data:** stop the server (Ctrl+C), delete
`data/freedge.db`, and start again.

**Settings (optional environment variables):**

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DB_PATH` | `data/freedge.db` | Where the SQLite file lives |

Example: `PORT=4000 npm start`

## How it works (architecture)

The app follows the standard **three-tier client-server** model:

```
 ┌──────────────────┐   HTTP + JSON    ┌──────────────────────┐    SQL     ┌─────────────┐
 │  Frontend        │ ───────────────► │  REST API            │ ─────────► │  Database   │
 │  (phone browser) │ ◄─────────────── │  (Express server)    │ ◄───────── │  (SQLite)   │
 │  public/         │                  │  server/             │            │  data/      │
 └──────────────────┘                  └──────────────────────┘            └─────────────┘
```

1. The browser loads `index.html`, `styles.css`, and `app.js` from the server.
2. `app.js` calls the API, e.g. `GET /api/items`.
3. The API checks the request, runs SQL against the database, and replies
   with JSON.
4. `app.js` redraws the list from that JSON.

One Express process serves both the frontend files and the API. That's
simpler to run and deploy, and it's still three separate tiers in the code.

**Key design decisions:**

- **The rules live on the server.** "Quantity can't go below 0" and
  "quantity 0 means empty" are enforced in `server/routes/items.js` and by
  database constraints. Anyone can send requests to an API without using our
  page, so the frontend's checks only give quick feedback; the server's
  checks are the real ones.
- **"Take 2", not "set to 8".** If two people both see 10 servings and each
  take 2, sending "set quantity to 8" twice would give 8 (wrong). Sending
  "take 2" twice lets the database do `quantity = quantity - 2` each time,
  giving 6 (right).
- **There's no `status` column.** An item is empty exactly when
  `quantity = 0`, so the two values can never disagree.

## Project structure

```
KTPhoodRecovery/
├── README.md            ← you are here
├── package.json         ← project info, dependencies, npm scripts
├── package-lock.json    ← exact dependency versions (commit it, don't edit by hand)
├── .gitignore           ← files git should ignore (node_modules, database)
├── server/              ← application server (tier 2)
│   ├── index.js         ← starts Express, serves public/, mounts the API
│   ├── db.js            ← opens SQLite, creates the items table, lists allowed units
│   └── routes/
│       └── items.js     ← all API endpoints + input validation
├── public/              ← frontend (tier 1), sent to the browser as-is
│   ├── index.html       ← page structure
│   ├── styles.css       ← mobile-first styling (supports light/dark mode)
│   └── app.js           ← calls the API, draws the list, handles buttons
└── data/                ← database (tier 3)
    └── freedge.db       ← created on first run, NOT committed to git
```

### Database table: `items`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER, primary key | Auto-numbered |
| `name` | TEXT | 1–100 characters |
| `quantity` | INTEGER | ≥ 0. **0 means empty** |
| `unit` | TEXT | `servings`, `items`, `containers`, or `bags` |
| `created_at` | TEXT | ISO timestamp (UTC) when added |
| `updated_at` | TEXT | ISO timestamp (UTC) of the last change |
| `emptied_at` | TEXT or NULL | When it hit 0 |

**To add a unit:** add it to `UNITS` in `server/db.js`. Because the
database's allowed-unit check is fixed when the table is created, you'll also
need to delete your local `data/freedge.db` (on a deployed app this would
need a proper migration).

## API endpoints

All requests and responses use JSON. On errors, the API responds with an
appropriate status code and `{ "error": "message" }`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/items` | none | `200` list of non-empty items, newest first | none |
| `POST` | `/api/items` | `{ "name": "Lasagna", "quantity": 10, "unit": "servings" }` | `201` the new item | `400` invalid input |
| `POST` | `/api/items/:id/take` | `{ "amount": 2 }` | `200` the updated item | `400` bad amount, more than is left, or already empty. `404` no such item |
| `POST` | `/api/items/:id/empty` | none | `200` the updated item (quantity 0) | `404` no such item |
| `GET` | `/api/units` | none | `200` `["servings","items","containers","bags"]` | none |

Example item:

```json
{
  "id": 1,
  "name": "Lasagna",
  "quantity": 8,
  "unit": "servings",
  "created_at": "2026-10-05T20:06:29Z",
  "updated_at": "2026-10-05T20:31:02Z",
  "emptied_at": null
}
```

Try the API from a terminal while the server is running:

```bash
curl http://localhost:3000/api/items
curl -X POST http://localhost:3000/api/items \
  -H "Content-Type: application/json" \
  -d '{"name":"Lasagna","quantity":10,"unit":"servings"}'
curl -X POST http://localhost:3000/api/items/1/take \
  -H "Content-Type: application/json" -d '{"amount":2}'
curl -X POST http://localhost:3000/api/items/1/empty
```

## Known limitations

- **No accounts:** anyone with the link can add, take, or empty anything,
  and there's no record of who did it. This is fine for a trusted community
  MVP, but there's no protection against pranks or mistakes.
- **No undo:** an item marked empty by mistake disappears from the list.
  It's still in the database, but the app has no way to bring it back yet.
- **One fridge only.**
- **Not real-time:** other people's changes appear on the next refresh
  (up to 30 seconds, or tap ⟳), not instantly.
- **No expiration dates or food-safety info:** people still need to use
  their judgment.
- **Whole numbers only:** you can't record "half a tray".
- **Local only so far:** the app isn't deployed yet. Before deploying,
  switch from SQLite to hosted Postgres: most free hosting services wipe
  local files on restart, which would erase a SQLite database.
- **No automated tests yet.**

---

## Team workflow and git guide

We're all learning git, so this section covers both **the rules we follow**
and **how to actually do them**.

### Rules

1. **Never commit directly to `main`.** `main` should always hold working
   code.
2. **Do every change on its own branch**, named for what it does:
   `feature/undo-empty`, `fix/take-button-mobile`, `docs/readme-setup`.
3. **Make small commits with clear messages** (see below).
4. **Always open a Pull Request (PR)** to merge into `main`.
5. **Get at least one teammate to review** before merging.
6. **Pull `main` before starting new work**, so you build on the latest code.

### Key ideas in plain English

| Term | Meaning |
|---|---|
| **Repository (repo)** | The project folder plus its full history. |
| **Commit** | A saved snapshot of your changes with a message explaining them. |
| **Branch** | A separate line of work. Your changes stay off `main` until merged. |
| **`origin`** | The copy of the repo on GitHub. |
| **Push** | Upload your commits to GitHub. |
| **Pull** | Download others' commits from GitHub into your local copy. |
| **Pull Request (PR)** | A request on GitHub to merge your branch into `main`. Teammates review it there. |
| **Merge** | Combine a branch's commits into another branch. |
| **Merge conflict** | Two branches changed the same lines, so git asks you to choose. |

### The everyday workflow, step by step

```bash
# 1. Start from an up-to-date main
git checkout main
git pull

# 2. Create a branch for your work
git checkout -b feature/short-description

# 3. Make changes, then see what changed
git status            # which files changed
git diff              # the actual line-by-line changes

# 4. Stage and commit (repeat as you go: small commits are better)
git add server/routes/items.js     # stage specific files
git commit -m "Add undo endpoint for emptied items"

# 5. Push your branch to GitHub (first push of a new branch)
git push -u origin feature/short-description
# later pushes on the same branch: just `git push`

# 6. Open a Pull Request (see below)

# 7. After the PR is merged, clean up
git checkout main
git pull
git branch -d feature/short-description
```

### Writing good commit messages

A teammate should understand **what changed and why** without opening the
code.

- **First line:** a short summary (about 50 characters) in the imperative,
  like "Add…", "Fix…", or "Update…". Imagine it completing the sentence "This
  commit will…".
- **Optional body:** after a blank line, explain *why* or anything
  non-obvious.
- **One logical change per commit:** don't mix "fix button color" with
  "add new endpoint".

| ✅ Good | ❌ Not helpful |
|---|---|
| `Add "Take…" button to choose an amount` | `changes` |
| `Fix quantity going negative on double tap` | `fixed stuff` |
| `Update README with phone testing steps` | `asdf` / `final version 2` |

For a commit with a body, run `git commit` with no `-m`. Your editor opens:
write the summary line, a blank line, then the details.

### Opening a Pull Request

**On the website (easiest):**
1. After `git push`, go to the repo on GitHub. A yellow banner offers
   **Compare & pull request**. Click it. (Or go to the **Pull requests**
   tab → **New pull request**.)
2. Make sure it says **base: `main`** ← **compare: `your-branch`**.
3. Write a title and description: **what** you changed, **why**, and **how
   to test it** (e.g. "Run `npm run dev`, add an item, tap Take 1, check the
   quantity drops").
4. Click **Create pull request**. Request a reviewer on the right.

**From the terminal (optional):** install the GitHub CLI
(`brew install gh`, then `gh auth login`) and run:
```bash
gh pr create --base main --title "Add undo for emptied items" --body "What / why / how to test"
```

### Reviewing a teammate's PR

1. Open the PR → **Files changed** tab to read the diff.
2. Click a line's **+** to leave a comment or question. Be kind and specific.
3. Test it locally if it's more than a tiny change:
   ```bash
   git fetch
   git checkout their-branch-name
   npm install
   npm run dev
   ```
4. **Review changes** → *Approve* or *Request changes*.
5. Once approved, the author (or reviewer) clicks **Merge pull request**,
   then **Delete branch**.

### Fixing common problems

| Situation | What to do |
|---|---|
| "Which branch am I on?" | `git status` (first line) or `git branch` |
| I made changes on `main` by accident (not committed yet) | `git checkout -b feature/new-branch`: your changes come with you |
| I want to undo changes to a file (not committed) | `git restore path/to/file`. **This throws away your edits** |
| I staged a file I didn't mean to | `git restore --staged path/to/file` |
| Typo in my last commit message (not pushed yet) | `git commit --amend -m "Better message"` |
| `git push` is rejected | Someone pushed to your branch first. Run `git pull`, then `git push` |
| My branch is behind `main` | `git checkout main && git pull && git checkout my-branch && git merge main` |
| Merge conflict | Open the files git lists, find the `<<<<<<<` / `=======` / `>>>>>>>` markers, keep the right code, delete the markers, then `git add` the file and `git commit`. Ask a teammate if unsure! |
| Something's broken and I'm confused | Stop, run `git status`, and ask. Avoid `--force` or `reset --hard` unless you know exactly what they do: they can delete work. |

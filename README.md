# KTPhoodRecovery

A mobile-first web app showing what's in the Cornell Food Recovery Network
community **freedge** (free fridge) right now. Built by KTP x FRN.

People currently coordinate over GroupMe, so anyone who hasn't checked the
chat doesn't know what's available. This app answers "what's in the freedge?"
at a glance and lets anyone keep that answer accurate.

**Contributors:**
- Charvi

---

## Contents

1. [What the app does](#what-the-app-does)
2. [Tech stack](#tech-stack)
3. [Running it locally](#running-it-locally)
4. [How it works (architecture)](#how-it-works-architecture)
5. [Project structure](#project-structure)
6. [Database functions](#database-functions)
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
- **Shared and live:** everyone sees the same fridge. When anyone changes
  something, every open copy of the app updates within a second or two.

## Tech stack

| Tier | Technology | Why we chose it |
|---|---|---|
| Frontend (client) | Plain **HTML, CSS, JavaScript** | No framework or build step, so every line is readable. One page doesn't need React. |
| Database (hosted) | **Supabase** (Postgres) | A free hosted database everyone's phone talks to, so an item added on one phone shows up on all of them. It uses real SQL and pushes live updates, and we don't have to run a server. |
| iPhone app (coming next) | **Capacitor** + **Xcode** | Wraps these same web files into an iOS app we can test with TestFlight. |

## Running it locally

### 1. Set up the database (one time, for the whole team)

Only one person needs to do this.

1. Create a free project at <https://supabase.com>.
2. In the dashboard, open **SQL Editor → New query**, paste in all of
   `supabase/schema.sql`, and click **Run**. This creates the `items` table,
   its rules, and live updates.
3. Open **Project Settings → API**. Copy the **Project URL** and the
   **anon public** key into `public/config.js`, then commit it.
   (The anon key is meant to be public. **Never** commit the `service_role`
   key.)

### 2. Get the code (one time)

```bash
git clone https://github.com/claregartz/KTPhoodRecovery.git
cd KTPhoodRecovery
```

### 3. Start the app

The app is just files in `public/`, so any static file server works. If you
have [Node.js](https://nodejs.org) (version 20 or newer):

```bash
npm start
```

Open the address it prints (usually <http://localhost:3000>). No Node? Use
`python3 -m http.server 3000 --directory public` and open
<http://localhost:3000>.

Everyone shares the **same** database, so items you add are real and show
up for everyone. Open the app in two browser windows to watch live updates.

**Try it on your phone:** with your phone on the same Wi-Fi as your laptop,
find your laptop's local IP (Mac: System Settings → Wi-Fi → Details) and open
`http://<that-ip>:3000` on your phone. Campus Wi-Fi (eduroam) may block this.
If it does, use your browser's mobile view instead (Chrome: right-click →
Inspect → phone icon).

**See or edit the data directly:** Supabase dashboard → **Table Editor →
items**.

## How it works (architecture)

```
 ┌──────────────────┐   HTTPS (supabase-js)   ┌───────────────────────────┐
 │  Frontend        │ ──────────────────────► │  Supabase (Postgres)      │
 │  (phone/browser) │ ◄────────────────────── │  items table + functions  │
 │  public/         │   live updates          │  supabase/schema.sql      │
 └──────────────────┘                         └───────────────────────────┘
```

1. The browser loads `index.html`, `styles.css`, `config.js`, and `app.js`.
2. `app.js` reads the list straight from the `items` table.
3. To change anything, `app.js` calls a database function (`add_item`,
   `take_item`, `empty_item`). The function checks the input, updates the
   table, and returns the item, or an error message the app shows as-is.
4. Supabase Realtime tells every open copy of the app that something
   changed, and each one reloads its list.

**Key design decisions:**

- **The rules live in the database.** There's no server of our own, and the
  anon key in `config.js` is visible to anyone who looks. So the database
  only lets the public **read** the table (a row level security policy).
  All writes go through the three functions, which do the real checks. The
  frontend's checks only give quick feedback.
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
├── package.json         ← project info and the `npm start` script
├── .gitignore           ← files git should ignore
├── supabase/
│   └── schema.sql       ← table, permissions, and functions. Run in Supabase's SQL Editor
└── public/              ← the app itself
    ├── index.html       ← page structure
    ├── styles.css       ← mobile-first styling (supports light/dark mode)
    ├── config.js        ← Supabase project URL + anon key
    └── app.js           ← reads/writes the database, draws the list, handles buttons
```

### Database table: `items`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint, primary key | Auto-numbered |
| `name` | text | 1–100 characters |
| `quantity` | integer | ≥ 0. **0 means empty** |
| `unit` | text | `servings`, `items`, `containers`, or `bags` |
| `created_at` | timestamptz | When it was added |
| `updated_at` | timestamptz | When it last changed |
| `emptied_at` | timestamptz or null | When it hit 0 |

**To add a unit:** add it to `UNITS` in `public/app.js` and to the three
places in `supabase/schema.sql` that list units. Because the table already
exists, also run this in the SQL Editor (with your new list):

```sql
alter table public.items drop constraint items_unit_check;
alter table public.items add constraint items_unit_check
  check (unit in ('servings', 'items', 'containers', 'bags', 'trays'));
```

## Database functions

The app calls these with `db.rpc('name', { ...args })`. Each returns the
item, or fails with a plain-English error message.

| Function | Arguments | Does | Errors |
|---|---|---|---|
| `add_item` | `p_name`, `p_quantity`, `p_unit` | Adds a new item | Bad name, quantity, or unit |
| `take_item` | `p_id`, `p_amount` | Subtracts `p_amount` | Bad amount, more than is left, already empty, no such item |
| `empty_item` | `p_id` | Sets quantity to 0 | No such item |

Reading the list doesn't need a function: the app selects from `items` where
`quantity > 0`, newest first.

Example item:

```json
{
  "id": 1,
  "name": "Lasagna",
  "quantity": 8,
  "unit": "servings",
  "created_at": "2026-10-05T20:06:29.123+00:00",
  "updated_at": "2026-10-05T20:31:02.456+00:00",
  "emptied_at": null
}
```

## Known limitations

- **No accounts:** anyone with the app can add, take, or empty anything,
  and there's no record of who did it. This is fine for a trusted community
  MVP, but there's no protection against pranks or mistakes. Supabase has
  built-in login if we want it later.
- **No undo:** an item marked empty by mistake disappears from the list.
  It's still in the database, but the app has no way to bring it back yet.
- **One fridge only.**
- **Needs internet:** the app can't show or change anything offline.
- **Free Supabase projects pause after about a week with no activity.**
  Un-pause it from the Supabase dashboard.
- **No expiration dates or food-safety info:** people still need to use
  their judgment.
- **Whole numbers only:** you can't record "half a tray".
- **Not an iPhone app yet:** Capacitor + Xcode + TestFlight is the next step.
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
git add public/app.js     # stage specific files
git commit -m "Add undo for emptied items"

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
  "add new feature".

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
   to test it** (e.g. "Run `npm start`, add an item, tap Take 1, check the
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
   npm start
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

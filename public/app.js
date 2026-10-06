// Frontend logic: talks to the Supabase database and draws the item list.
//
// The pattern used throughout:
//   1. Ask the database for data.
//   2. Store it in `state`.
//   3. Call render() to redraw the page from `state`.
// Because the page is always drawn from `state`, it can't show something
// different from what we last got back from the database.

// Backup in case a live update is missed (e.g. the phone was asleep).
const AUTO_REFRESH_MS = 30_000;

// Units a person can choose when adding an item. Must match the list in
// supabase/schema.sql, which is what actually enforces it.
const UNITS = ['servings', 'items', 'containers', 'bags'];

// `supabase` comes from the library loaded in index.html; FREEDGE_CONFIG
// comes from config.js.
const db = supabase.createClient(
  window.FREEDGE_CONFIG.supabaseUrl,
  window.FREEDGE_CONFIG.supabaseAnonKey
);

const state = {
  items: [],
  lastLoaded: null,
  // Which card has its "take how many?" or "mark empty?" panel open,
  // e.g. { id: 3, type: 'take' }. Only one at a time.
  openPanel: null,
  // True when someone else changed the fridge while this person was busy
  // typing, so we reload once they're done.
  stale: false,
};

// Grab the page elements we need once, up front.
const els = {
  list: document.getElementById('item-list'),
  emptyState: document.getElementById('empty-state'),
  errorBanner: document.getElementById('error-banner'),
  lastUpdated: document.getElementById('last-updated'),
  refreshBtn: document.getElementById('refresh-btn'),
  openAddBtn: document.getElementById('open-add-btn'),
  addDialog: document.getElementById('add-dialog'),
  addForm: document.getElementById('add-form'),
  addName: document.getElementById('add-name'),
  addQuantity: document.getElementById('add-quantity'),
  addUnit: document.getElementById('add-unit'),
  addError: document.getElementById('add-error'),
  cancelAddBtn: document.getElementById('cancel-add-btn'),
};

// ---------------------------------------------------------------------------
// Talking to the database
// ---------------------------------------------------------------------------

// Supabase returns { data, error } instead of throwing. This turns errors
// (like "Only 3 servings of Lasagna left.") into thrown Errors with that
// message, so callers can just use try/catch.
async function query(request) {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return data;
}

// Changes go through the functions in supabase/schema.sql, which check the
// input and enforce the rules. The app isn't allowed to write to the table
// directly.
function callFunction(name, args) {
  return query(db.rpc(name, args));
}

async function loadItems() {
  els.refreshBtn.classList.add('spinning');
  state.stale = false;
  try {
    // Every item that isn't empty, newest first
    state.items = await query(
      db.from('items')
        .select('*')
        .gt('quantity', 0)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
    );
    state.lastLoaded = new Date();
    // If the item whose panel was open is gone (someone emptied it), close it.
    if (state.openPanel && !state.items.some((i) => i.id === state.openPanel.id)) {
      state.openPanel = null;
    }
    hideError();
  } catch (err) {
    showError(`Couldn't load the fridge: ${err.message}`);
  } finally {
    els.refreshBtn.classList.remove('spinning');
    render();
  }
}

// Runs an action (take / empty), then reloads the list so everyone's
// changes, not just ours, show up.
async function runItemAction(name, args) {
  try {
    await callFunction(name, args);
    state.openPanel = null;
  } catch (err) {
    showError(err.message);
  }
  await loadItems();
}

function takeItem(id, amount) {
  return runItemAction('take_item', { p_id: id, p_amount: amount });
}

function emptyItem(id) {
  return runItemAction('empty_item', { p_id: id });
}

// ---------------------------------------------------------------------------
// Drawing the page
// ---------------------------------------------------------------------------

function render() {
  els.list.replaceChildren(...state.items.map(renderItem));
  els.emptyState.hidden = state.items.length > 0 || !state.lastLoaded;
  els.lastUpdated.textContent = state.lastLoaded
    ? `Updated ${timeAgo(state.lastLoaded)}`
    : 'Loading…';
}

// Small helper for building elements:
//   el('button', { className: 'btn', onclick: fn }, 'Click me')
// Text is always set with textContent (never innerHTML), so an item named
// "<script>..." shows up as plain text instead of running as code.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function renderItem(item) {
  const panel = state.openPanel?.id === item.id ? state.openPanel.type : null;

  return el('li', { className: 'item' },
    el('h2', { className: 'item-name' }, item.name),
    el('p', { className: 'item-meta' },
      el('span', { className: 'item-qty' }, `${item.quantity} ${unitLabel(item)}`),
      ` · updated ${timeAgo(new Date(item.updated_at))}`
    ),
    el('div', { className: 'item-actions' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onclick: () => takeItem(item.id, 1),
      }, 'Take 1'),
      // "Take…" only makes sense if there's more than 1 left
      item.quantity > 1
        ? el('button', {
            type: 'button',
            className: 'btn',
            onclick: () => togglePanel(item.id, 'take'),
          }, 'Take…')
        : null,
      el('button', {
        type: 'button',
        className: 'btn btn-danger',
        onclick: () => togglePanel(item.id, 'empty'),
      }, 'Empty')
    ),
    panel === 'take' ? renderTakePanel(item) : null,
    panel === 'empty' ? renderEmptyPanel(item) : null
  );
}

function renderTakePanel(item) {
  const input = el('input', {
    type: 'number',
    inputMode: 'numeric',
    min: 1,
    max: item.quantity,
    step: 1,
    value: 1,
    ariaLabel: `How many ${item.unit} of ${item.name} to take`,
  });

  const form = el('form', { className: 'item-panel' },
    el('p', {}, `How many ${item.unit}? (${item.quantity} left)`),
    input,
    el('button', { type: 'button', className: 'btn', onclick: closePanel }, 'Cancel'),
    el('button', { type: 'submit', className: 'btn btn-primary' }, 'Take')
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault(); // stop the browser from reloading the page
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 1 || amount > item.quantity) {
      showError(`Enter a whole number from 1 to ${item.quantity}.`);
      return;
    }
    takeItem(item.id, amount);
  });
  // Focus the box once it's on screen so the number keyboard pops up.
  requestAnimationFrame(() => input.focus());
  return form;
}

function renderEmptyPanel(item) {
  return el('div', { className: 'item-panel' },
    el('p', {}, `Mark ${item.name} as empty? It will be removed from the list.`),
    el('button', { type: 'button', className: 'btn', onclick: closePanel }, 'Cancel'),
    el('button', {
      type: 'button',
      className: 'btn btn-danger-solid',
      onclick: () => emptyItem(item.id),
    }, 'Yes, it\'s empty')
  );
}

function togglePanel(id, type) {
  const isSame = state.openPanel?.id === id && state.openPanel?.type === type;
  state.openPanel = isSame ? null : { id, type };
  render();
}

function closePanel() {
  state.openPanel = null;
  if (state.stale) loadItems();
  else render();
}

// "1 servings" reads oddly, so drop the trailing "s" for a quantity of 1.
function unitLabel(item) {
  return item.quantity === 1 ? item.unit.replace(/s$/, '') : item.unit;
}

// Turns a date into "just now", "5 min ago", "3 h ago", or "2 d ago".
function timeAgo(date) {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.hidden = false;
}

function hideError() {
  els.errorBanner.hidden = true;
}

// ---------------------------------------------------------------------------
// Add item dialog
// ---------------------------------------------------------------------------

els.openAddBtn.addEventListener('click', () => {
  els.addForm.reset();
  els.addError.hidden = true;
  els.addDialog.showModal();
  els.addName.focus();
});

els.cancelAddBtn.addEventListener('click', () => els.addDialog.close());

els.addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitBtn = els.addForm.querySelector('[type="submit"]');
  const item = {
    name: els.addName.value.trim(),
    quantity: Number(els.addQuantity.value),
    unit: els.addUnit.value,
  };

  // Quick checks for instant feedback. The database checks again, because
  // anyone can call it without using this page.
  if (!item.name) return showAddError('Please enter a name.');
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    return showAddError('Quantity must be a whole number of at least 1.');
  }

  submitBtn.disabled = true; // prevent double-taps from adding it twice
  try {
    await callFunction('add_item', {
      p_name: item.name,
      p_quantity: item.quantity,
      p_unit: item.unit,
    });
    els.addDialog.close();
    await loadItems();
  } catch (err) {
    showAddError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

function showAddError(message) {
  els.addError.textContent = message;
  els.addError.hidden = false;
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

els.refreshBtn.addEventListener('click', loadItems);

// Reload, unless the person is in the middle of typing: redrawing would
// wipe their input, so remember to reload once they're done instead.
function refreshIfIdle() {
  const busy = state.openPanel || els.addDialog.open;
  if (busy) {
    state.stale = true;
  } else if (document.visibilityState === 'visible') {
    loadItems();
  }
}

// Live updates: Supabase tells us the moment anyone adds, takes, or empties
// something, and we reload the list.
db.channel('items-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, refreshIfIdle)
  .subscribe();

// Backups: re-check periodically, and whenever the person comes back to
// the app.
setInterval(refreshIfIdle, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', refreshIfIdle);
els.addDialog.addEventListener('close', () => {
  if (state.stale) loadItems();
});

els.addUnit.replaceChildren(...UNITS.map((unit) => new Option(unit, unit)));
loadItems();

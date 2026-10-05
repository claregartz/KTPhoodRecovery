// Frontend logic: talks to the API and draws the item list.
//
// The pattern used throughout:
//   1. Ask the API for data (fetch).
//   2. Store it in `state`.
//   3. Call render() to redraw the page from `state`.
// Because the page is always drawn from `state`, it can't show something
// different from what we last got back from the server.

const AUTO_REFRESH_MS = 30_000; // re-check the fridge every 30 seconds

const state = {
  items: [],
  lastLoaded: null,
  // Which card has its "take how many?" or "mark empty?" panel open,
  // e.g. { id: 3, type: 'take' }. Only one at a time.
  openPanel: null,
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
// Talking to the API
// ---------------------------------------------------------------------------

// A small wrapper around fetch(). It sends/receives JSON and turns API
// errors (like 400 "Only 3 servings left") into thrown Errors with the
// server's message, so callers can just use try/catch.
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

async function loadItems() {
  els.refreshBtn.classList.add('spinning');
  try {
    state.items = await api('/items');
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

async function loadUnits() {
  try {
    const units = await api('/units');
    els.addUnit.replaceChildren(
      ...units.map((unit) => new Option(unit, unit))
    );
  } catch (err) {
    showError(`Couldn't load units: ${err.message}`);
  }
}

// Runs an action (take / empty), then reloads the list so everyone's
// changes, not just ours, show up.
async function runItemAction(path, body) {
  try {
    await api(path, { method: 'POST', body });
    state.openPanel = null;
  } catch (err) {
    showError(err.message);
  }
  await loadItems();
}

function takeItem(id, amount) {
  return runItemAction(`/items/${id}/take`, { amount });
}

function emptyItem(id) {
  return runItemAction(`/items/${id}/empty`);
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
  render();
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

  // Quick checks for instant feedback. The server checks again, because
  // anyone can send requests to the API without using this page.
  if (!item.name) return showAddError('Please enter a name.');
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    return showAddError('Quantity must be a whole number of at least 1.');
  }

  submitBtn.disabled = true; // prevent double-taps from adding it twice
  try {
    await api('/items', { method: 'POST', body: item });
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

// Re-check periodically, and whenever the person comes back to the tab.
// Skip if they're in the middle of typing, so we don't wipe their input.
function refreshIfIdle() {
  const busy = state.openPanel || els.addDialog.open;
  if (!busy && document.visibilityState === 'visible') loadItems();
}
setInterval(refreshIfIdle, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', refreshIfIdle);

loadUnits();
loadItems();

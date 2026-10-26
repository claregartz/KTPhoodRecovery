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

// How long the "Undo" popup stays on screen after a change. (The database
// separately refuses undos older than 15 minutes.)
const UNDO_POPUP_MS = 8_000;

// Units a person can choose when adding an item. Must match the list in
// supabase/schema.sql, which is what actually enforces it.
const UNITS = ['servings', 'items', 'containers', 'bags'];

// The allergens people can pick, in the order they're shown. `key` is what's
// stored in the database and must match the list in supabase/schema.sql.
// Sesame has no emoji, so it gets a little drawn seed instead (see styles.css).
const ALLERGENS = [
  { key: 'peanuts',   label: 'Peanuts',   icon: '🥜' },
  { key: 'tree_nuts', label: 'Tree nuts', icon: '🌰' },
  { key: 'milk',      label: 'Milk',      icon: '🥛' },
  { key: 'eggs',      label: 'Eggs',      icon: '🥚' },
  { key: 'gluten',    label: 'Gluten',    icon: '🌾' },
  { key: 'soy',       label: 'Soy',       icon: '🫘' },
  { key: 'fish',      label: 'Fish',      icon: '🐟' },
  { key: 'sesame',    label: 'Sesame',    icon: null },
];

// Suggested while typing a name in the Add form, so the same food gets the
// same name ("Pizza", not "pizza" and "PIZZA") and stacks. Anything else can
// still be typed. Names already in the fridge are suggested too.
const COMMON_FOODS = [
  'Apples', 'Bagels', 'Bananas', 'Bread', 'Burritos', 'Cake', 'Chicken',
  'Chips', 'Clementines', 'Cookies', 'Croissants', 'Curry', 'Donuts',
  'Dumplings', 'Fried rice', 'Fruit cups', 'Fruit salad', 'Granola bars',
  'Grapes', 'Hummus', 'Lasagna', 'Mac and cheese', 'Milk', 'Muffins',
  'Noodles', 'Oranges', 'Pasta', 'Pastries', 'Pizza', 'Quesadillas', 'Rice',
  'Rice and beans', 'Salad', 'Sandwiches', 'Soup', 'Stir fry', 'Sushi',
  'Tacos', 'Veggie tray', 'Wraps', 'Yogurt',
];

// The two extra answers in the Add form. Each one cancels out every other
// choice. In the database "none" is stored as an empty list and "not sure"
// as null.
const ALLERGEN_NONE = 'none';
const ALLERGEN_UNKNOWN = 'unknown';

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
  // This person's most recent change while its Undo popup is showing:
  // { token, message }. Kept only on this device.
  lastAction: null,
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
  foodSuggestions: document.getElementById('food-suggestions'),
  stackHint: document.getElementById('stack-hint'),
  addQuantity: document.getElementById('add-quantity'),
  addUnit: document.getElementById('add-unit'),
  addAllergens: document.getElementById('add-allergens'),
  addError: document.getElementById('add-error'),
  cancelAddBtn: document.getElementById('cancel-add-btn'),
  fridge: document.getElementById('fridge'),
  fridgeInterior: document.getElementById('fridge-interior'),
  fridgeDoor: document.getElementById('fridge-door'),
  doorNote: document.getElementById('door-note'),
  openFridgeBtn: document.getElementById('open-fridge-btn'),
  closeFridgeBtn: document.getElementById('close-fridge-btn'),
  undoToast: document.getElementById('undo-toast'),
  undoMessage: document.getElementById('undo-message'),
  undoBtn: document.getElementById('undo-btn'),
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
// changes, not just ours, show up. `message` describes the change for the
// Undo popup, e.g. "Took 2 servings of Lasagna".
async function runItemAction(name, args, message) {
  try {
    const undoToken = await callFunction(name, args);
    rememberLastAction(undoToken, message);
    state.openPanel = null;
  } catch (err) {
    showError(err.message);
  }
  await loadItems();
}

function takeItem(item, amount) {
  return runItemAction(
    'take_item',
    { p_id: item.id, p_amount: amount },
    `Took ${amountText(amount, item.unit)} of ${item.name}`
  );
}

function emptyItem(item) {
  return runItemAction('empty_item', { p_id: item.id }, `Marked ${item.name} as empty`);
}

// Undo only ever reverses this person's own last change: the database
// hands the undo code only to whoever made the change.
let undoTimer;

function rememberLastAction(token, message) {
  clearTimeout(undoTimer);
  // No code means nothing changed (e.g. it was already empty).
  state.lastAction = token ? { token, message } : null;
  if (token) {
    undoTimer = setTimeout(() => {
      state.lastAction = null;
      render();
    }, UNDO_POPUP_MS);
  }
}

async function undoLastAction() {
  const action = state.lastAction;
  if (!action) return;
  els.undoBtn.disabled = true; // prevent double-taps
  // Clear it either way: if it failed, the error says why, and trying
  // again won't help.
  clearTimeout(undoTimer);
  state.lastAction = null;
  try {
    await callFunction('undo_action', { p_token: action.token });
  } catch (err) {
    showError(err.message);
  } finally {
    els.undoBtn.disabled = false;
  }
  await loadItems();
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
  els.doorNote.textContent = doorNoteText();

  // The message is left in place while hiding so it doesn't blank out
  // mid-fade.
  els.undoToast.classList.toggle('show', Boolean(state.lastAction));
  if (state.lastAction) els.undoMessage.textContent = state.lastAction.message;
}

// The sticky note on the fridge door, e.g. "3 things inside!"
function doorNoteText() {
  if (!state.lastLoaded) return 'Loading…';
  const count = state.items.length;
  if (count === 0) return 'Empty right now';
  return count === 1 ? '1 thing inside!' : `${count} things inside!`;
}

// ---------------------------------------------------------------------------
// Opening and closing the fridge
// ---------------------------------------------------------------------------
// These just flip data-state on the fridge between "closed" and "open".
// The door animation itself is a CSS transition in styles.css.

function isFridgeOpen() {
  return els.fridge.dataset.state === 'open';
}

function openFridge() {
  if (isFridgeOpen()) return;
  els.fridge.dataset.state = 'open';
  els.fridgeInterior.inert = false; // items can be tapped now
  els.openFridgeBtn.hidden = true;
  els.openFridgeBtn.setAttribute('aria-expanded', 'true');
}

function closeFridge() {
  if (!isFridgeOpen()) return;
  state.openPanel = null;
  render();
  els.fridge.dataset.state = 'closed';
  els.fridgeInterior.inert = true;
  els.openFridgeBtn.hidden = false;
  els.openFridgeBtn.setAttribute('aria-expanded', 'false');
  // The fridge shrinks back to door height, so bring it into view.
  els.fridge.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      el('span', { className: 'item-qty' }, amountText(item.quantity, item.unit)),
      ` · updated ${timeAgo(new Date(item.updated_at))}`
    ),
    renderAllergens(item),
    el('div', { className: 'item-actions' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onclick: () => takeItem(item, 1),
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

// One of: "Contains 🥛 Milk 🌾 Gluten", "None of the listed allergens", or
// "Allergens unknown" (null, which includes items added before allergens
// existed).
function renderAllergens(item) {
  if (item.allergens == null) {
    return el('p', { className: 'allergens allergens-unknown' },
      '⚠ Allergens unknown, ask or skip if you have allergies');
  }
  if (item.allergens.length === 0) {
    return el('p', { className: 'allergens allergens-none' },
      '✓ None of the listed allergens');
  }
  return el('p', { className: 'allergens' },
    el('span', { className: 'allergens-label' }, 'Contains'),
    ...item.allergens.map((key) => {
      // Fall back to the raw key if the database knows an allergen this
      // copy of the app doesn't yet.
      const allergen = ALLERGENS.find((a) => a.key === key) ?? { label: key };
      return el('span', { className: 'allergen-chip' },
        allergenIcon(allergen), allergen.label);
    })
  );
}

function allergenIcon(allergen) {
  if (allergen.icon) {
    return el('span', { className: 'allergen-icon', ariaHidden: 'true' }, allergen.icon);
  }
  if (allergen.key === 'sesame') {
    return el('span', { className: 'allergen-icon seed-icon', ariaHidden: 'true' });
  }
  return null;
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
    takeItem(item, amount);
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
      onclick: () => emptyItem(item),
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

// amountText(3, 'servings') -> "3 servings". "1 servings" reads oddly, so
// drop the trailing "s" for a quantity of 1.
function amountText(quantity, unit) {
  return `${quantity} ${quantity === 1 ? unit.replace(/s$/, '') : unit}`;
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
  fillFoodSuggestions();
  updateStackHint();
  els.addDialog.showModal();
  els.addName.focus();
});

els.cancelAddBtn.addEventListener('click', () => els.addDialog.close());

els.addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitBtn = els.addForm.querySelector('[type="submit"]');
  const item = {
    name: standardName(els.addName.value),
    quantity: Number(els.addQuantity.value),
    unit: els.addUnit.value,
    allergens: readAllergens(),
  };

  // Quick checks for instant feedback. The database checks again, because
  // anyone can call it without using this page.
  if (!item.name) return showAddError('Please enter a name.');
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    return showAddError('Quantity must be a whole number of at least 1.');
  }
  if (item.allergens === undefined) {
    return showAddError('Please answer the allergen question. "Not sure" is fine.');
  }

  submitBtn.disabled = true; // prevent double-taps from adding it twice
  try {
    const saved = await callFunction('add_item', {
      p_name: item.name,
      p_quantity: item.quantity,
      p_unit: item.unit,
      p_allergens: item.allergens,
    });
    // The database stacks it onto a matching item when there is one (see
    // add_item in supabase/schema.sql). Then it has more than we added.
    const stacked = saved.item.quantity > item.quantity;
    rememberLastAction(saved.undo_token, stacked
      ? `Added ${item.quantity} to ${saved.item.name}, now ${amountText(saved.item.quantity, saved.item.unit)}`
      : `Added ${amountText(item.quantity, item.unit)} of ${item.name}`);
    els.addDialog.close();
    await loadItems();
    openFridge(); // show them their item on the shelf
  } catch (err) {
    showAddError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// The allergen choices: one checkbox per allergen, then "None of these" and
// "Not sure".
function renderAllergenOptions() {
  const option = (value, label, icon) =>
    el('label', { className: 'allergen-option' },
      el('input', { type: 'checkbox', name: 'allergens', value }),
      icon,
      label
    );
  els.addAllergens.replaceChildren(
    ...ALLERGENS.map((a) => option(a.key, a.label, allergenIcon(a))),
    option(ALLERGEN_NONE, 'None of these', null),
    option(ALLERGEN_UNKNOWN, 'Not sure', null)
  );
}

// "None of these" and "Not sure" can't be combined with anything else, so
// ticking one clears the rest, and ticking an allergen clears both of them.
els.addAllergens.addEventListener('change', (event) => {
  const box = event.target;
  if (!box.checked) return;
  const isAnswerOnItsOwn = (value) => value === ALLERGEN_NONE || value === ALLERGEN_UNKNOWN;
  for (const other of els.addAllergens.querySelectorAll('input')) {
    if (other !== box && (isAnswerOnItsOwn(box.value) || isAnswerOnItsOwn(other.value))) {
      other.checked = false;
    }
  }
});

// Turns the ticked boxes into what the database stores:
//   a list of allergen keys, [] for "None of these", or null for "Not sure".
// Returns undefined if nothing is ticked (the question wasn't answered).
function readAllergens() {
  const ticked = [...els.addAllergens.querySelectorAll('input:checked')].map((box) => box.value);
  if (ticked.length === 0) return undefined;
  if (ticked.includes(ALLERGEN_UNKNOWN)) return null;
  if (ticked.includes(ALLERGEN_NONE)) return [];
  return ticked;
}

// ---------------------------------------------------------------------------
// Food stacks: same food, one item
// ---------------------------------------------------------------------------
// The database decides whether to stack (add_item in supabase/schema.sql).
// This part just helps people type matching names and tells them ahead of
// time when their food will stack.

// "  pizza " and "Pizza" are the same food. Must match how add_item compares
// names.
function nameKey(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Fixes capitals to match a food already in the fridge or a common food,
// so "pizza" is saved as "Pizza". Anything else is kept as typed.
function standardName(typed) {
  const key = nameKey(typed);
  const known = [...state.items.map((i) => i.name), ...COMMON_FOODS];
  return known.find((name) => nameKey(name) === key) ?? typed.trim();
}

// Fridge items first, then common foods, with no repeats.
function fillFoodSuggestions() {
  const seen = new Set();
  const names = [...state.items.map((i) => i.name), ...COMMON_FOODS].filter((name) => {
    const key = nameKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  els.foodSuggestions.replaceChildren(...names.map((name) => new Option(name)));
}

// "Pizza is already in the fridge (5 servings)…" under the name box when the
// name and unit match something. Allergens have to match too, which the
// person may not have answered yet, so the hint says so.
function updateStackHint() {
  const key = nameKey(els.addName.value);
  const match = key && state.items.find((i) =>
    nameKey(i.name) === key && i.unit === els.addUnit.value);
  els.stackHint.hidden = !match;
  if (match) {
    els.stackHint.textContent = `${match.name} is already in the fridge ` +
      `(${amountText(match.quantity, match.unit)}). If the allergens match, ` +
      'this adds to it instead of making a new item.';
  }
}

els.addName.addEventListener('input', updateStackHint);
els.addUnit.addEventListener('change', updateStackHint);

function showAddError(message) {
  els.addError.textContent = message;
  els.addError.hidden = false;
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

els.refreshBtn.addEventListener('click', loadItems);
els.openFridgeBtn.addEventListener('click', openFridge);
els.fridgeDoor.addEventListener('click', openFridge);
els.closeFridgeBtn.addEventListener('click', closeFridge);
els.undoBtn.addEventListener('click', undoLastAction);

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
renderAllergenOptions();
loadItems();

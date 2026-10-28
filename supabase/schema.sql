-- Database setup for Supabase.
--
-- Run this once: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. It's safe to run again; it won't delete any items.
--
-- There's no server of our own, so the app talks to the database directly
-- using the public "anon" key. Anyone can pull that key out of the app, so
-- every rule has to live here in the database:
--   * Anyone can READ items (row level security policy below).
--   * Nobody can insert/update/delete rows directly. All changes go through
--     the functions below (add_item, take_item, empty_item, undo_action,
--     submit_feedback), which check their input first.
--   * Nobody can read feedback from the app, only in the Supabase dashboard.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

-- "Empty" is not its own column: an item is empty exactly when quantity = 0.
-- That way the two can never disagree.
--
-- To add a unit, change the list here AND `UNITS` in public/app.js.
create table if not exists public.items (
  id          bigint      generated always as identity primary key,
  name        text        not null check (char_length(name) between 1 and 100),
  quantity    integer     not null check (quantity >= 0),
  unit        text        not null check (unit in ('servings', 'items', 'containers', 'bags')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  emptied_at  timestamptz
);

-- Allergens, as reported by whoever added the item. One column holds all
-- three possible answers, so they can never disagree:
--   null              -> "Not sure" (also every item added before this existed)
--   '{}' (empty list) -> "None of these"
--   '{milk,gluten}'   -> contains milk and gluten
--
-- The allowed keys are listed below. To change them, change the list here,
-- in add_item below, AND `ALLERGENS` in public/app.js.
alter table public.items add column if not exists allergens text[];

alter table public.items drop constraint if exists items_allergens_check;

-- The first version of the list had 'wheat' (now 'gluten'). Update any
-- items saved with it so they fit the new list.
update public.items
set allergens = array_replace(allergens, 'wheat', 'gluten')
where 'wheat' = any(allergens);

alter table public.items add constraint items_allergens_check
  check (allergens <@ array['peanuts', 'tree_nuts', 'milk', 'eggs', 'gluten',
                            'soy', 'fish', 'shellfish', 'sesame']::text[]);

-- Vegan or vegetarian, as reported by whoever added the item. Optional:
--   null         -> not marked (also every item added before this existed)
--   'vegetarian' -> no meat or fish
--   'vegan'      -> no animal products at all
-- An item can't be vegan and contain milk, eggs, fish or shellfish, or be
-- vegetarian and contain fish or shellfish.
alter table public.items add column if not exists diet text;

alter table public.items drop constraint if exists items_diet_check;
alter table public.items add constraint items_diet_check check (
  diet in ('vegan', 'vegetarian')
  and not (diet = 'vegan' and allergens && array['milk', 'eggs', 'fish', 'shellfish'])
  and not (diet = 'vegetarian' and allergens && array['fish', 'shellfish'])
);

-- Every add / take / empty is recorded here so it can be undone.
--
-- Undo works by doing the opposite change (undoing "take 2" adds 2 back)
-- rather than restoring an old quantity, so anything other people did in
-- the meantime still counts. `undo_token` is a random code that only the
-- person who made the change gets back, so nobody can undo someone else's
-- change.
create table if not exists public.actions (
  id          bigint      generated always as identity primary key,
  item_id     bigint      not null references public.items (id) on delete cascade,
  kind        text        not null,
  amount      integer     not null check (amount >= 1),
  undo_token  uuid        not null unique default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  undone_at   timestamptz
);

-- 'add' made a new item; 'stack' added to one already in the fridge.
alter table public.actions drop constraint if exists actions_kind_check;
alter table public.actions add constraint actions_kind_check
  check (kind in ('add', 'stack', 'take', 'empty'));

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- No policies on `actions`, so the app can't read it at all (that would
-- leak everyone's undo codes). Only the functions below touch it.
alter table public.actions enable row level security;

alter table public.items enable row level security;

-- With row level security on, anything without a policy is denied. This is
-- the only policy, so the app can read but not write the table directly.
drop policy if exists "Anyone can view items" on public.items;
create policy "Anyone can view items"
  on public.items for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Functions the app calls (supabase.rpc('add_item', ...) etc.)
-- ---------------------------------------------------------------------------
--
-- `security definer` means the function runs with the table owner's
-- permissions, so it can write even though the app can't. Each function
-- checks its input before writing. Errors are raised with a plain-English
-- message, which the app shows to the user as-is.
--
-- add_item, take_item and empty_item return an undo code for undo_action
-- (add_item returns it alongside the item).

-- These used to return the item. Postgres can't change what a function
-- returns in place, so remove the old versions first. (Before allergens,
-- add_item took 3 arguments; remove that version too so there aren't two
-- add_items.)
drop function if exists public.add_item(text, integer, text);
drop function if exists public.add_item(text, integer, text, text[]);
drop function if exists public.add_item(text, integer, text, text[], text);
drop function if exists public.take_item(bigint, integer);
drop function if exists public.empty_item(bigint);

-- add_item('Lasagna', 10, 'servings', '{milk,gluten}', 'vegetarian')
--   -> { "undo_token": <undo code>, "item": <the new or stacked item> }
--
-- p_allergens follows the same rules as the column: null = not sure,
-- '{}' = none of these. It's optional so older copies of the app that don't
-- send it still work (their items count as "not sure"). p_diet is 'vegan',
-- 'vegetarian', or null (not marked), and is optional for the same reason.
--
-- Food stacks: if the fridge already has the same food (name ignoring
-- capitals and extra spaces) in the same unit with the same allergen and
-- vegan/vegetarian answers, the quantity is added to that item instead of making a second one. So
-- adding 3 pizza to 5 pizza gives one "Pizza: 8". If the answers differ,
-- they stay separate, so nobody's allergy or diet info gets mixed up. The app can
-- tell a merge happened because the returned quantity is more than it sent.
-- Undoing a stack takes back just the amount added, not the whole item.

create or replace function public.add_item(
  p_name text, p_quantity integer, p_unit text, p_allergens text[] default null,
  p_diet text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  -- "  Pizza " and "pizza" count as the same food
  v_match_name text := lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_all_allergens text[] := array['peanuts', 'tree_nuts', 'milk', 'eggs', 'gluten',
                                  'soy', 'fish', 'shellfish', 'sesame'];
  v_allergens text[];
  v_item public.items;
  v_kind text := 'add'; -- 'stack' if it was added to an existing item
  v_token uuid;
begin
  if char_length(v_name) not between 1 and 100 then
    raise exception 'Name must be 1–100 characters.';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Quantity must be a whole number of at least 1.';
  end if;
  if p_unit is null or p_unit not in ('servings', 'items', 'containers', 'bags') then
    raise exception 'Unit must be one of: servings, items, containers, bags.';
  end if;
  if array_position(p_allergens, null) is not null
     or not (p_allergens <@ v_all_allergens) then
    raise exception 'Allergens must be from: %.', array_to_string(v_all_allergens, ', ');
  end if;
  if p_diet not in ('vegan', 'vegetarian') then
    raise exception 'Diet must be vegan, vegetarian, or left blank.';
  elsif p_diet = 'vegan' and p_allergens && array['milk', 'eggs', 'fish', 'shellfish'] then
    raise exception 'Vegan food can''t contain milk, eggs, fish, or shellfish.';
  elsif p_diet = 'vegetarian' and p_allergens && array['fish', 'shellfish'] then
    raise exception 'Vegetarian food can''t contain fish or shellfish.';
  end if;

  -- Drop duplicates and put them in the standard order, so the same answer
  -- is always stored the same way. (Stays null for "not sure".)
  if p_allergens is not null then
    v_allergens := array(
      select a from unnest(v_all_allergens) with ordinality as t(a, n)
      where a = any(p_allergens)
      order by n
    );
  end if;

  -- If two people add "Pizza" at the same moment, make the second wait for
  -- the first, so they stack instead of both creating a new item.
  perform pg_advisory_xact_lock(hashtext(v_match_name));

  -- Stack onto a matching item that's still in the fridge, if there is one.
  -- (`is not distinct from` treats two nulls, i.e. two "not sure"s, as equal.)
  update public.items
  set quantity = quantity + p_quantity, updated_at = now()
  where id = (
    select id from public.items
    where quantity > 0
      and unit = p_unit
      and allergens is not distinct from v_allergens
      and diet is not distinct from p_diet
      and lower(regexp_replace(name, '\s+', ' ', 'g')) = v_match_name
    order by updated_at desc
    limit 1
  )
  returning * into v_item;

  if found then
    v_kind := 'stack';
  else
    insert into public.items (name, quantity, unit, allergens, diet)
    values (v_name, p_quantity, p_unit, v_allergens, p_diet)
    returning * into v_item;
  end if;

  insert into public.actions (item_id, kind, amount)
  values (v_item.id, v_kind, p_quantity)
  returning undo_token into v_token;
  return jsonb_build_object('undo_token', v_token, 'item', to_jsonb(v_item));
end;
$$;

-- take_item(3, 2) -> undo code
--
-- Subtracting happens inside the database (quantity = quantity - amount), so
-- if two people tap "Take" at the same moment, both subtractions count.
-- `quantity >= amount` makes sure we never go below zero. When the result
-- hits zero, emptied_at is stamped.
create or replace function public.take_item(p_id bigint, p_amount integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item  public.items;
  v_token uuid;
begin
  if p_amount is null or p_amount < 1 then
    raise exception 'Amount must be a whole number of at least 1.';
  end if;

  update public.items
  set quantity   = quantity - p_amount,
      updated_at = now(),
      emptied_at = case when quantity - p_amount = 0 then now() else emptied_at end
  where id = p_id and quantity >= p_amount
  returning * into v_item;

  if not found then
    -- Nothing was updated. Work out why so the user gets a helpful message.
    select * into v_item from public.items where id = p_id;
    if not found then
      raise exception 'Item not found.';
    elsif v_item.quantity = 0 then
      raise exception '% is already empty.', v_item.name;
    else
      raise exception 'Only % % of % left.', v_item.quantity, v_item.unit, v_item.name;
    end if;
  end if;

  insert into public.actions (item_id, kind, amount)
  values (p_id, 'take', p_amount)
  returning undo_token into v_token;
  return v_token;
end;
$$;

-- empty_item(3) -> undo code, or null if it was already empty
--
-- If it's already empty this changes nothing, so emptied_at keeps the time
-- the item first ran out.
create or replace function public.empty_item(p_id bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item  public.items;
  v_token uuid;
begin
  -- `for update` locks the row so nobody can take some between reading the
  -- quantity here and setting it to 0 below. Undo needs the exact amount.
  select * into v_item from public.items where id = p_id for update;
  if not found then
    raise exception 'Item not found.';
  elsif v_item.quantity = 0 then
    return null; -- nothing changed, so nothing to undo
  end if;

  update public.items
  set quantity = 0, updated_at = now(), emptied_at = now()
  where id = p_id;

  insert into public.actions (item_id, kind, amount)
  values (p_id, 'empty', v_item.quantity)
  returning undo_token into v_token;
  return v_token;
end;
$$;

-- undo_action('<undo code>') -> nothing
--
-- Reverses one change, as long as it's recent and doesn't clash with what
-- other people did since:
--   * Undo add:   removes the item, but only if nobody has taken from or
--                 emptied it since. Otherwise use Take or Empty.
--   * Undo stack: takes back the amount added, if that much is still there.
--   * Undo take:  adds the amount back, so other people's takes still
--                 count. Refused if someone marked it empty since, because
--                 they're saying there's none left.
--   * Undo empty: puts back the amount that was there.
--
-- The 15-minute limit is a backstop; the app only offers Undo for 8 seconds
-- (UNDO_POPUP_MS in public/app.js).
create or replace function public.undo_action(p_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action public.actions;
  v_item   public.items;
begin
  -- `for update` makes a double-tapped Undo wait for the first, so it can't
  -- undo the same change twice.
  select * into v_action from public.actions where undo_token = p_token for update;
  if not found then
    raise exception 'Nothing to undo.';
  elsif v_action.undone_at is not null then
    raise exception 'That was already undone.';
  elsif v_action.created_at < now() - interval '15 minutes' then
    raise exception 'Too late to undo: that was more than 15 minutes ago.';
  end if;

  select * into v_item from public.items where id = v_action.item_id for update;

  if v_action.kind = 'add' then
    if exists (
      select 1 from public.actions
      where item_id = v_item.id and id <> v_action.id and undone_at is null
    ) then
      raise exception '% has changed since it was added, so this can''t be undone. Use Take or Empty instead.', v_item.name;
    end if;
    -- Also deletes its row in `actions` (on delete cascade).
    delete from public.items where id = v_item.id;
    return;
  end if;

  if v_action.kind = 'stack' then
    if v_item.quantity < v_action.amount then
      raise exception 'Some of the % has been taken since, so this can''t be undone. Use Take instead.', v_item.name;
    end if;
    update public.items
    set quantity   = quantity - v_action.amount,
        updated_at = now(),
        emptied_at = case when quantity = v_action.amount then now() else emptied_at end
    where id = v_item.id;
    update public.actions set undone_at = now() where id = v_action.id;
    return;
  end if;

  if v_action.kind = 'take' and exists (
    select 1 from public.actions
    where item_id = v_item.id and kind = 'empty' and id > v_action.id and undone_at is null
  ) then
    raise exception 'Someone marked % as empty since then, so this can''t be undone.', v_item.name;
  end if;

  -- Undo take or empty: put the amount back.
  update public.items
  set quantity = quantity + v_action.amount, updated_at = now(), emptied_at = null
  where id = v_item.id;

  update public.actions set undone_at = now() where id = v_action.id;
end;
$$;

-- Postgres lets everyone run new functions by default; limit it to the app.
revoke execute on function public.add_item(text, integer, text, text[], text) from public;
revoke execute on function public.take_item(bigint, integer)                  from public;
revoke execute on function public.empty_item(bigint)                          from public;
revoke execute on function public.undo_action(uuid)                           from public;
grant  execute on function public.add_item(text, integer, text, text[], text) to anon, authenticated;
grant  execute on function public.take_item(bigint, integer)                  to anon, authenticated;
grant  execute on function public.empty_item(bigint)                          to anon, authenticated;
grant  execute on function public.undo_action(uuid)                           to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------------------

-- Tell Supabase Realtime to broadcast changes to this table, so every open
-- app hears about them instantly. (Skipped if it's already set up.)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'
  ) then
    alter publication supabase_realtime add table public.items;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------------
--
-- The "Feedback" button in the app saves here. Like `actions`, the app can't
-- read or write this table at all: it can only call submit_feedback below.
-- Read submissions in the Supabase dashboard (Table Editor → feedback),
-- which signs in as the owner and so can see everything.
--
-- There's no link to `items`: feedback is about the app as a whole, and
-- items get deleted by undo, which would take their feedback with them.
--
-- To change the categories, change the list here, in submit_feedback below,
-- AND `FEEDBACK_CATEGORIES` in public/app.js.
create table if not exists public.feedback (
  id          bigint      generated always as identity primary key,
  category    text        not null,
  rating      integer     check (rating between 1 and 5),
  message     text        check (char_length(message) between 1 and 2000),
  email       text        check (char_length(email) between 3 and 254
                                 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at  timestamptz not null default now(),
  -- A category on its own doesn't tell us anything
  check (rating is not null or message is not null)
);

alter table public.feedback drop constraint if exists feedback_category_check;
alter table public.feedback add constraint feedback_category_check
  check (category in ('general', 'wrong_info', 'missing_food', 'bug', 'idea'));

-- Recent submissions, used only to slow down spam (see submit_feedback).
-- `requester` is a one-way scramble (hash) of the sender's IP address, not
-- the address itself, and rows are deleted after an hour, so this doesn't
-- keep a record of who sent what.
create table if not exists public.feedback_throttle (
  requester   text        not null,
  created_at  timestamptz not null default now()
);
create index if not exists feedback_throttle_created_at_idx
  on public.feedback_throttle (created_at);

-- No policies, so with row level security on nobody but the owner can
-- read or write these. Supabase also gives the app's roles full table
-- permissions by default; take those away too, as a second lock.
alter table public.feedback          enable row level security;
alter table public.feedback_throttle enable row level security;
revoke all on table public.feedback          from public, anon, authenticated;
revoke all on table public.feedback_throttle from public, anon, authenticated;

-- submit_feedback('bug', 4, 'The Take button…', 'netid@cornell.edu') -> nothing
--
-- Everything but the category is optional, but there has to be a rating or
-- a message. Blank text counts as left out. Error messages never repeat
-- what was typed.
--
-- Spam limits: 5 submissions per 10 minutes from one IP address, and 100
-- per hour from everyone together (a backstop in case someone fakes their
-- address, so the free database can't be filled up).
create or replace function public.submit_feedback(
  p_category text, p_rating integer default null, p_message text default null,
  p_email text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  -- Supabase passes the request's headers in here. The first address in
  -- x-forwarded-for is the sender's.
  v_ip text := btrim(split_part(
    coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for', ''),
    ',', 1));
  v_requester text;
begin
  if p_category is null
     or p_category not in ('general', 'wrong_info', 'missing_food', 'bug', 'idea') then
    raise exception 'Please choose a category.';
  end if;
  if p_rating is not null and p_rating not between 1 and 5 then
    raise exception 'Rating must be from 1 to 5.';
  end if;
  if char_length(v_message) > 2000 then
    raise exception 'Message must be 2000 characters or fewer.';
  end if;
  if v_message is null and p_rating is null then
    raise exception 'Please add a rating or a message.';
  end if;
  if v_email is not null and (char_length(v_email) > 254
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'That email address doesn''t look right. You can also leave it blank.';
  end if;

  v_requester := encode(pg_catalog.sha256(convert_to('freedge-feedback:' || v_ip, 'UTF8')), 'hex');

  -- Make simultaneous submissions take turns, so the counts below are right.
  perform pg_advisory_xact_lock(hashtext('submit_feedback'));

  delete from public.feedback_throttle where created_at < now() - interval '1 hour';

  if (select count(*) from public.feedback_throttle
      where requester = v_requester
        and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'You''ve sent a lot of feedback in a short time. Please try again in a few minutes.';
  end if;
  if (select count(*) from public.feedback_throttle) >= 100 then
    raise exception 'We''re getting a lot of feedback right now. Please try again later.';
  end if;

  insert into public.feedback_throttle (requester) values (v_requester);
  insert into public.feedback (category, rating, message, email)
  values (p_category, p_rating, v_message, v_email);
end;
$$;

revoke execute on function public.submit_feedback(text, integer, text, text) from public;
grant  execute on function public.submit_feedback(text, integer, text, text) to anon, authenticated;

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
--     the three functions below (add_item, take_item, empty_item), which
--     check their input first.

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

-- The first version of the list had 'wheat' (now 'gluten') and 'shellfish'
-- (removed). Update any items saved with those so they fit the new list.
update public.items
set allergens = array_remove(array_replace(allergens, 'wheat', 'gluten'), 'shellfish')
where allergens && array['wheat', 'shellfish'];

alter table public.items add constraint items_allergens_check
  check (allergens <@ array['peanuts', 'tree_nuts', 'milk', 'eggs', 'gluten',
                            'soy', 'fish', 'sesame']::text[]);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

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

-- add_item('Lasagna', 10, 'servings', '{milk,gluten}') -> the new item
--
-- p_allergens follows the same rules as the column: null = not sure,
-- '{}' = none of these. It's optional so older copies of the app that don't
-- send it still work (their items count as "not sure").
--
-- Food stacks: if the fridge already has the same food (name ignoring
-- capitals and extra spaces) in the same unit with the same allergen answer,
-- the quantity is added to that item instead of making a second one. So
-- adding 3 pizza to 5 pizza gives one "Pizza: 8". If the allergens differ,
-- they stay separate, so nobody's allergy info gets mixed up. The app can
-- tell a merge happened because the returned quantity is more than it sent.

-- Before allergens, add_item took 3 arguments. Remove that version so there
-- aren't two add_items.
drop function if exists public.add_item(text, integer, text);

create or replace function public.add_item(
  p_name text, p_quantity integer, p_unit text, p_allergens text[] default null
)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  -- "  Pizza " and "pizza" count as the same food
  v_match_name text := lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_all_allergens text[] := array['peanuts', 'tree_nuts', 'milk', 'eggs', 'gluten',
                                  'soy', 'fish', 'sesame'];
  v_allergens text[];
  v_item public.items;
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
      and lower(regexp_replace(name, '\s+', ' ', 'g')) = v_match_name
    order by updated_at desc
    limit 1
  )
  returning * into v_item;

  if not found then
    insert into public.items (name, quantity, unit, allergens)
    values (v_name, p_quantity, p_unit, v_allergens)
    returning * into v_item;
  end if;
  return v_item;
end;
$$;

-- take_item(3, 2) -> the updated item
--
-- Subtracting happens inside the database (quantity = quantity - amount), so
-- if two people tap "Take" at the same moment, both subtractions count.
-- `quantity >= amount` makes sure we never go below zero. When the result
-- hits zero, emptied_at is stamped.
create or replace function public.take_item(p_id bigint, p_amount integer)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
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

  if found then
    return v_item;
  end if;

  -- Nothing was updated. Work out why so the user gets a helpful message.
  select * into v_item from public.items where id = p_id;
  if not found then
    raise exception 'Item not found.';
  elsif v_item.quantity = 0 then
    raise exception '% is already empty.', v_item.name;
  else
    raise exception 'Only % % of % left.', v_item.quantity, v_item.unit, v_item.name;
  end if;
end;
$$;

-- empty_item(3) -> the updated item (quantity 0)
--
-- If it's already empty this changes nothing, so emptied_at keeps the time
-- the item first ran out.
create or replace function public.empty_item(p_id bigint)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
begin
  update public.items
  set quantity = 0, updated_at = now(), emptied_at = now()
  where id = p_id and quantity > 0;

  select * into v_item from public.items where id = p_id;
  if not found then
    raise exception 'Item not found.';
  end if;
  return v_item;
end;
$$;

-- Postgres lets everyone run new functions by default; limit it to the app.
revoke execute on function public.add_item(text, integer, text, text[]) from public;
revoke execute on function public.take_item(bigint, integer)            from public;
revoke execute on function public.empty_item(bigint)                    from public;
grant  execute on function public.add_item(text, integer, text, text[]) to anon, authenticated;
grant  execute on function public.take_item(bigint, integer)            to anon, authenticated;
grant  execute on function public.empty_item(bigint)                    to anon, authenticated;

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

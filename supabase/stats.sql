-- Usage stats for the freedge.
--
-- These only READ data. Run one at a time: Supabase dashboard → SQL Editor →
-- New query → paste one query → Run. (Running the whole file only shows the
-- last result.)
--
-- Where the numbers come from:
--   * `actions` has one row per add / stack / take / empty, with when it
--     happened and how much. Undone actions are skipped below. Undoing a
--     brand-new add deletes the item and its row, so it never counts.
--   * `items` has one row per food ever put in the fridge (stacking adds to
--     an existing row instead of making a new one).
-- Anything done while testing the app counts too, since it uses the same
-- database. Times are shown in Ithaca time.
--
-- Visitor numbers (how many people open the app) aren't in the database;
-- they're in Vercel → the project → Analytics.


-- 1. All-time totals
select
  (select count(*) from items)                                        as foods_logged,
  (select coalesce(sum(amount), 0) from actions
     where kind in ('add', 'stack') and undone_at is null)            as amount_added,
  (select coalesce(sum(amount), 0) from actions
     where kind = 'take' and undone_at is null)                       as amount_taken,
  (select count(*) from actions
     where kind = 'empty' and undone_at is null)                      as times_marked_empty,
  (select count(*) from items where quantity > 0)                     as in_fridge_now;


-- 2. Activity per week
select
  date_trunc('week', created_at at time zone 'America/New_York')::date as week_of,
  count(*) filter (where kind in ('add', 'stack'))                    as adds,
  coalesce(sum(amount) filter (where kind in ('add', 'stack')), 0)    as amount_added,
  count(*) filter (where kind = 'take')                               as takes,
  coalesce(sum(amount) filter (where kind = 'take'), 0)               as amount_taken
from actions
where undone_at is null
group by week_of
order by week_of desc;


-- 3. Most common foods (capitals and extra spaces ignored)
select
  lower(trim(i.name))   as food,
  count(distinct i.id)  as times_dropped_off,
  sum(a.amount)         as amount_added
from actions a
join items i on i.id = a.item_id
where a.kind in ('add', 'stack') and a.undone_at is null
group by food
order by amount_added desc
limit 20;


-- 4. Busiest hours of the day
select
  extract(hour from created_at at time zone 'America/New_York')::int as hour,
  count(*) filter (where kind in ('add', 'stack'))                    as adds,
  count(*) filter (where kind = 'take')                               as takes
from actions
where undone_at is null
group by hour
order by hour;


-- 5. How long food lasts: time from first added to emptied
select
  round(avg(extract(epoch from emptied_at - created_at) / 3600)::numeric, 1)
    as avg_hours_in_fridge,
  count(*) as foods_emptied
from items
where emptied_at is not null;


-- 6. Feedback so far
select
  count(*)                    as submissions,
  round(avg(rating), 2)       as avg_rating,
  count(*) filter (where message is not null) as with_a_message
from feedback;

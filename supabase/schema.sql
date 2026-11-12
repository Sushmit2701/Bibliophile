-- Bibliophile — optional sync (step 1).
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- It's safe to run again.
--
-- Every book, passage, your settings and your review history is one row, owned by you.
-- Row-level security means each signed-in person can only ever read or change their own rows.

create table if not exists public.records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('book', 'item', 'settings', 'reviewLog')),
  id         text        not null check (char_length(id) between 1 and 100),
  data       jsonb       check (data is null or pg_column_size(data) < 512000),
  deleted    boolean     not null default false,
  client_at  timestamptz not null default now(),  -- when the change was made on the device
  updated_at timestamptz not null default now(),  -- when the server received it (set below)
  primary key (user_id, kind, id)
);
create index if not exists records_user_updated on public.records (user_id, updated_at);

create or replace function public.records_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

alter table public.records enable row level security;
drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.records from anon;
grant select, insert, update, delete on public.records to authenticated;

-- "Delete my account" in Settings. Removes the sign-in and, through the cascade, every row above.
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Bibliophile — optional sync and book clubs.
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

-- =====================================================================
-- Book clubs: small groups (up to 10 people) that join with an invite link.
-- The tables can't be read or written directly; everything goes through the
-- functions below, which check that you're a member (or the owner) first.
-- =====================================================================

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  updated_at   timestamptz not null default now()
);

create table if not exists public.clubs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  invite_code text not null unique,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.club_members (
  club_id   uuid not null references public.clubs (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (club_id, user_id)
);
create index if not exists club_members_user on public.club_members (user_id);

alter table public.profiles enable row level security;
alter table public.clubs enable row level security;
alter table public.club_members enable row level security;
revoke all on public.profiles, public.clubs, public.club_members from anon, authenticated;

-- ---------- helpers ----------
create or replace function public.club_role(p_club uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.club_members where club_id = p_club and user_id = auth.uid();
$$;

create or replace function public.make_invite_code() returns text
language sql volatile set search_path = '' as $$
  select substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
$$;

create or replace function public.set_display_name(p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Please add your name.'; end if;
  insert into public.profiles (id, display_name) values (auth.uid(), left(trim(p_name), 40))
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();
end $$;

create or replace function public.my_profile() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('display_name', display_name) from public.profiles where id = auth.uid();
$$;

-- ---------- clubs ----------
create or replace function public.create_club(p_name text, p_description text default '', p_display_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Please give your book club a name.'; end if;
  if (select count(*) from public.club_members where user_id = auth.uid()) >= 20 then
    raise exception 'You''re already in 20 book clubs.';
  end if;
  if p_display_name is not null then perform public.set_display_name(p_display_name); end if;
  insert into public.clubs (name, description, invite_code, created_by)
  values (left(trim(p_name), 60), left(trim(coalesce(p_description, '')), 500), public.make_invite_code(), auth.uid())
  returning id into cid;
  insert into public.club_members (club_id, user_id, role) values (cid, auth.uid(), 'owner');
  return cid;
end $$;

create or replace function public.my_clubs() returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.joined_at), '[]'::json) from (
    select c.id, c.name, c.description, m.role, m.joined_at,
           (select count(*) from public.club_members m2 where m2.club_id = c.id) as members
    from public.club_members m join public.clubs c on c.id = m.club_id
    where m.user_id = auth.uid()
  ) x;
$$;

create or replace function public.club_details(p_club uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare r json;
begin
  if public.club_role(p_club) is null then raise exception 'You''re not a member of this book club.'; end if;
  select json_build_object(
    'id', c.id, 'name', c.name, 'description', c.description, 'invite_code', c.invite_code,
    'created_at', c.created_at, 'role', public.club_role(c.id), 'me', auth.uid(),
    'members', (select json_agg(json_build_object(
        'user_id', m.user_id, 'role', m.role, 'joined_at', m.joined_at,
        'name', coalesce(p.display_name, 'A reader')) order by m.joined_at)
      from public.club_members m left join public.profiles p on p.id = m.user_id
      where m.club_id = c.id)
  ) into r from public.clubs c where c.id = p_club;
  return r;
end $$;

-- What an invite link shows before joining: just the name, description and size.
create or replace function public.club_preview(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('id', c.id, 'name', c.name, 'description', c.description,
    'members', (select count(*) from public.club_members m where m.club_id = c.id),
    'member', exists (select 1 from public.club_members m where m.club_id = c.id and m.user_id = auth.uid()))
  from public.clubs c where c.invite_code = p_code;
$$;

create or replace function public.join_club(p_code text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  select id into cid from public.clubs where invite_code = p_code for update;
  if cid is null then raise exception 'This invite link doesn''t work any more. Ask for a new one.'; end if;
  if p_display_name is not null then perform public.set_display_name(p_display_name); end if;
  if public.club_role(cid) is not null then return cid; end if;
  if (select count(*) from public.club_members where club_id = cid) >= 10 then
    raise exception 'This book club is full (10 people).';
  end if;
  if (select count(*) from public.club_members where user_id = auth.uid()) >= 20 then
    raise exception 'You''re already in 20 book clubs.';
  end if;
  insert into public.club_members (club_id, user_id) values (cid, auth.uid());
  return cid;
end $$;

create or replace function public.update_club(p_club uuid, p_name text, p_description text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.club_role(p_club) is distinct from 'owner' then raise exception 'Only the person who runs the club can change this.'; end if;
  if char_length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Please give your book club a name.'; end if;
  update public.clubs set name = left(trim(p_name), 60), description = left(trim(coalesce(p_description, '')), 500) where id = p_club;
end $$;

create or replace function public.reset_invite(p_club uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare code text := public.make_invite_code();
begin
  if public.club_role(p_club) is distinct from 'owner' then raise exception 'Only the person who runs the club can do this.'; end if;
  update public.clubs set invite_code = code where id = p_club;
  return code;
end $$;

create or replace function public.remove_member(p_club uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.club_role(p_club) is distinct from 'owner' then raise exception 'Only the person who runs the club can do this.'; end if;
  if p_user = auth.uid() then raise exception 'To leave your own club, use Leave.'; end if;
  delete from public.club_members where club_id = p_club and user_id = p_user;
end $$;

-- Leaving: if the owner leaves, the longest-standing member takes over; the last one out closes the club.
create or replace function public.leave_club(p_club uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare was text := public.club_role(p_club); heir uuid;
begin
  if was is null then return; end if;
  delete from public.club_members where club_id = p_club and user_id = auth.uid();
  if was = 'owner' then
    select user_id into heir from public.club_members where club_id = p_club order by joined_at limit 1;
    if heir is null then delete from public.clubs where id = p_club;
    else update public.club_members set role = 'owner' where club_id = p_club and user_id = heir; end if;
  end if;
end $$;

-- "Delete my account" in Settings: leave every club (handing them on), then remove the sign-in,
-- which also removes your synced library and profile.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid;
begin
  if auth.uid() is null then return; end if;
  for c in select club_id from public.club_members where user_id = auth.uid() loop
    perform public.leave_club(c);
  end loop;
  delete from auth.users where id = auth.uid();
end $$;

-- Who may call what: only signed-in people, except the invite preview.
do $$
declare f text;
begin
  foreach f in array array['club_role(uuid)', 'make_invite_code()', 'set_display_name(text)', 'my_profile()',
    'create_club(text,text,text)', 'my_clubs()', 'club_details(uuid)', 'club_preview(text)', 'join_club(text,text)',
    'update_club(uuid,text,text)', 'reset_invite(uuid)', 'remove_member(uuid,uuid)', 'leave_club(uuid)', 'delete_my_account()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function public.club_preview(text) to anon;

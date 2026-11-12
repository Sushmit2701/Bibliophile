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

-- remove_member and leave_club are defined further down, with the reading-together tables.

-- =====================================================================
-- Reading together: the club's book, everyone's progress, shared passages,
-- goals and deadlines. Again, only reachable through the functions below.
-- =====================================================================

create table if not exists public.club_books (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references public.clubs (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  author      text not null default '' check (char_length(author) <= 300),
  cover       text not null default '' check (char_length(cover) <= 1000),
  pages       int  not null default 0 check (pages between 0 and 100000),
  isbn        text not null default '' check (char_length(isbn) <= 20),
  status      text not null default 'current' check (status in ('current', 'done')),
  chosen_by   uuid references auth.users (id) on delete set null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists club_books_one_current on public.club_books (club_id) where status = 'current';

create table if not exists public.club_progress (
  club_book_id uuid not null references public.club_books (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  page         int  not null default 0 check (page between 0 and 100000),
  status       text not null default 'reading' check (status in ('want', 'reading', 'finished', 'paused', 'abandoned')),
  updated_at   timestamptz not null default now(),
  primary key (club_book_id, user_id)
);

create table if not exists public.club_passages (
  id           uuid primary key default gen_random_uuid(),
  club_book_id uuid not null references public.club_books (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  item_id      text not null check (char_length(item_id) between 1 and 100),
  kind         text not null default 'highlight' check (kind in ('highlight', 'quote', 'note', 'idea', 'question', 'word')),
  text         text not null check (char_length(text) between 1 and 5000),
  note         text not null default '' check (char_length(note) <= 5000),
  page         text not null default '' check (char_length(page) <= 40),
  chapter      text not null default '' check (char_length(chapter) <= 200),
  shared_at    timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (club_book_id, user_id, item_id)
);

create table if not exists public.club_goals (
  id           uuid primary key default gen_random_uuid(),
  club_id      uuid not null references public.clubs (id) on delete cascade,
  club_book_id uuid references public.club_books (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 120),
  target_page  int check (target_page between 1 and 100000),
  due          date not null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists club_goals_club on public.club_goals (club_id, due);

alter table public.club_books enable row level security;
alter table public.club_progress enable row level security;
alter table public.club_passages enable row level security;
alter table public.club_goals enable row level security;
revoke all on public.club_books, public.club_progress, public.club_passages, public.club_goals from anon, authenticated;

create or replace function public.club_of_book(p_book uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select club_id from public.club_books where id = p_book;
$$;

-- Everything the club page shows about reading together, in one call.
create or replace function public.club_reading(p_club uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare cur uuid; r json;
begin
  if public.club_role(p_club) is null then raise exception 'You''re not a member of this book club.'; end if;
  select id into cur from public.club_books where club_id = p_club and status = 'current';
  select json_build_object(
    'current', (select row_to_json(b) from public.club_books b where b.id = cur),
    'past', coalesce((select json_agg(row_to_json(b) order by b.finished_at desc)
                      from (select * from public.club_books where club_id = p_club and status = 'done' order by finished_at desc limit 12) b), '[]'::json),
    'progress', coalesce((select json_agg(json_build_object(
        'user_id', m.user_id, 'name', coalesce(pr.display_name, 'A reader'),
        'page', coalesce(p.page, 0), 'status', p.status, 'updated_at', p.updated_at) order by coalesce(p.page, 0) desc, m.joined_at)
      from public.club_members m
      left join public.profiles pr on pr.id = m.user_id
      left join public.club_progress p on p.club_book_id = cur and p.user_id = m.user_id
      where m.club_id = p_club and cur is not null), '[]'::json),
    'passages', coalesce((select json_agg(x order by x.shared_at desc) from (
        select cp.id, cp.user_id, coalesce(pr.display_name, 'A reader') as name, cp.item_id, cp.kind, cp.text, cp.note, cp.page, cp.chapter, cp.shared_at
        from public.club_passages cp
        join public.club_members m on m.club_id = p_club and m.user_id = cp.user_id
        left join public.profiles pr on pr.id = cp.user_id
        where cp.club_book_id = cur order by cp.shared_at desc limit 300) x), '[]'::json),
    'goals', coalesce((select json_agg(json_build_object(
        'id', g.id, 'title', g.title, 'target_page', g.target_page, 'due', g.due, 'created_by', g.created_by, 'club_book_id', g.club_book_id) order by g.due, g.created_at)
      from public.club_goals g where g.club_id = p_club and (g.club_book_id is null or g.club_book_id = cur)), '[]'::json)
  ) into r;
  return r;
end $$;

-- Choosing the next book (the person who runs the club). The current one moves to "read together".
create or replace function public.set_club_book(p_club uuid, p_title text, p_author text default '', p_cover text default '', p_pages int default 0, p_isbn text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare bid uuid;
begin
  if public.club_role(p_club) is distinct from 'owner' then raise exception 'Only the person who runs the club can choose the book.'; end if;
  if char_length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Please add the book''s title.'; end if;
  update public.club_books set status = 'done', finished_at = now() where club_id = p_club and status = 'current';
  insert into public.club_books (club_id, title, author, cover, pages, isbn, chosen_by)
  values (p_club, left(trim(p_title), 300), left(trim(coalesce(p_author, '')), 300),
          case when coalesce(p_cover, '') ~ '^https://' then left(p_cover, 1000) else '' end,
          greatest(0, least(coalesce(p_pages, 0), 100000)), left(coalesce(p_isbn, ''), 20), auth.uid())
  returning id into bid;
  return bid;
end $$;

create or replace function public.finish_club_book(p_club uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.club_role(p_club) is distinct from 'owner' then raise exception 'Only the person who runs the club can do this.'; end if;
  update public.club_books set status = 'done', finished_at = now() where club_id = p_club and status = 'current';
end $$;

-- Your own progress in a club book (sent automatically from your library).
create or replace function public.set_progress(p_book uuid, p_page int, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.club_role(public.club_of_book(p_book)) is null then raise exception 'You''re not a member of this book club.'; end if;
  insert into public.club_progress (club_book_id, user_id, page, status)
  values (p_book, auth.uid(), greatest(0, least(coalesce(p_page, 0), 100000)),
          case when p_status in ('want', 'reading', 'finished', 'paused', 'abandoned') then p_status else 'reading' end)
  on conflict (club_book_id, user_id) do update set page = excluded.page, status = excluded.status, updated_at = now();
end $$;

-- Sharing a passage you chose; editing it here updates the shared copy.
create or replace function public.share_passage(p_book uuid, p_item_id text, p_kind text, p_text text, p_note text default '', p_page text default '', p_chapter text default '')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.club_role(public.club_of_book(p_book)) is null then raise exception 'You''re not a member of this book club.'; end if;
  if (select count(*) from public.club_passages where club_book_id = p_book and user_id = auth.uid() and item_id <> p_item_id) >= 500 then
    raise exception 'You''ve shared 500 passages from this book — that''s the limit.';
  end if;
  insert into public.club_passages (club_book_id, user_id, item_id, kind, text, note, page, chapter)
  values (p_book, auth.uid(), p_item_id,
          case when p_kind in ('highlight', 'quote', 'note', 'idea', 'question', 'word') then p_kind else 'highlight' end,
          left(p_text, 5000), left(coalesce(p_note, ''), 5000), left(coalesce(p_page, ''), 40), left(coalesce(p_chapter, ''), 200))
  on conflict (club_book_id, user_id, item_id) do update
    set kind = excluded.kind, text = excluded.text, note = excluded.note, page = excluded.page, chapter = excluded.chapter, updated_at = now();
end $$;

create or replace function public.unshare_passage(p_book uuid, p_item_id text) returns void
language sql security definer set search_path = '' as $$
  delete from public.club_passages where club_book_id = p_book and user_id = auth.uid() and item_id = p_item_id;
$$;

-- Goals and deadlines: any member can add one; its author or the club's owner can remove it.
create or replace function public.add_goal(p_club uuid, p_title text, p_target_page int, p_due date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare gid uuid;
begin
  if public.club_role(p_club) is null then raise exception 'You''re not a member of this book club.'; end if;
  if char_length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Please describe the goal.'; end if;
  if p_due is null then raise exception 'Please choose a date.'; end if;
  if (select count(*) from public.club_goals where club_id = p_club and due >= current_date) >= 30 then raise exception 'That''s plenty of goals for now (30).'; end if;
  insert into public.club_goals (club_id, club_book_id, title, target_page, due, created_by)
  values (p_club, (select id from public.club_books where club_id = p_club and status = 'current'),
          left(trim(p_title), 120), nullif(greatest(0, least(coalesce(p_target_page, 0), 100000)), 0), p_due, auth.uid())
  returning id into gid;
  return gid;
end $$;

create or replace function public.remove_goal(p_goal uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g record;
begin
  select club_id, created_by into g from public.club_goals where id = p_goal;
  if g is null then return; end if;
  if g.created_by is distinct from auth.uid() and public.club_role(g.club_id) is distinct from 'owner' then
    raise exception 'Only whoever added this goal, or the person who runs the club, can remove it.';
  end if;
  delete from public.club_goals where id = p_goal;
end $$;

-- When someone leaves (or is removed), their progress and shared passages leave with them.
create or replace function public.forget_member(p_club uuid, p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.club_progress where user_id = p_user and club_book_id in (select id from public.club_books where club_id = p_club);
  delete from public.club_passages where user_id = p_user and club_book_id in (select id from public.club_books where club_id = p_club);
$$;
revoke all on function public.forget_member(uuid, uuid) from public, anon, authenticated;

create or replace function public.remove_member(p_club uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.club_role(p_club) is distinct from 'owner' then raise exception 'Only the person who runs the club can do this.'; end if;
  if p_user = auth.uid() then raise exception 'To leave your own club, use Leave.'; end if;
  delete from public.club_members where club_id = p_club and user_id = p_user;
  perform public.forget_member(p_club, p_user);
end $$;

create or replace function public.leave_club(p_club uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare was text := public.club_role(p_club); heir uuid;
begin
  if was is null then return; end if;
  delete from public.club_members where club_id = p_club and user_id = auth.uid();
  perform public.forget_member(p_club, auth.uid());
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
    'update_club(uuid,text,text)', 'reset_invite(uuid)', 'remove_member(uuid,uuid)', 'leave_club(uuid)', 'delete_my_account()',
    'club_of_book(uuid)', 'club_reading(uuid)', 'set_club_book(uuid,text,text,text,integer,text)', 'finish_club_book(uuid)',
    'set_progress(uuid,integer,text)', 'share_passage(uuid,text,text,text,text,text,text)', 'unshare_passage(uuid,text)',
    'add_goal(uuid,text,integer,date)', 'remove_goal(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function public.club_preview(text) to anon;

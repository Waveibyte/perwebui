create extension if not exists pgcrypto;

create table if not exists public.guestbook_messages (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,
  message text not null,
  country_name text not null default '未知国家',
  region_name text not null default '未知地区',
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  constraint guestbook_nickname_length check (char_length(nickname) between 1 and 20),
  constraint guestbook_message_length check (char_length(message) between 1 and 80),
  constraint guestbook_country_length check (char_length(country_name) between 1 and 80),
  constraint guestbook_region_length check (char_length(region_name) between 1 and 80)
);

create index if not exists guestbook_messages_created_at_idx
  on public.guestbook_messages (created_at desc);

create table if not exists public.guestbook_message_private (
  message_id uuid primary key references public.guestbook_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.guestbook_rate_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists guestbook_rate_events_user_time_idx
  on public.guestbook_rate_events (user_id, created_at desc);
create index if not exists guestbook_rate_events_ip_time_idx
  on public.guestbook_rate_events (ip_hash, created_at desc);

alter table public.guestbook_messages enable row level security;
alter table public.guestbook_message_private enable row level security;
alter table public.guestbook_rate_events enable row level security;

revoke all on table public.guestbook_messages from anon, authenticated;
revoke all on table public.guestbook_message_private from anon, authenticated;
revoke all on table public.guestbook_rate_events from anon, authenticated;
grant select (id, nickname, message, country_name, region_name, created_at)
  on public.guestbook_messages to anon, authenticated;

drop policy if exists "public can read visible guestbook messages"
  on public.guestbook_messages;
create policy "public can read visible guestbook messages"
  on public.guestbook_messages
  for select
  to anon, authenticated
  using (is_visible = true);

create or replace function public.submit_guestbook_message(
  p_user_id uuid,
  p_nickname text,
  p_message text,
  p_country text,
  p_region text,
  p_ip_hash text
)
returns table (
  id uuid,
  nickname text,
  message text,
  country_name text,
  region_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_message_id uuid;
  v_recent_user integer;
  v_recent_ip integer;
begin
  if p_user_id is null then
    raise exception using errcode = '42501', message = '请刷新页面后重试';
  end if;

  p_nickname := btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g'));
  p_message := btrim(regexp_replace(coalesce(p_message, ''), '\s+', ' ', 'g'));

  if char_length(p_nickname) < 1 or char_length(p_nickname) > 20 then
    raise exception using errcode = '22023', message = '昵称需要 1–20 个字符';
  end if;

  if char_length(p_message) < 1 or char_length(p_message) > 80 then
    raise exception using errcode = '22023', message = '留言需要 1–80 个字符';
  end if;

  select count(*) into v_recent_user
  from public.guestbook_rate_events
  where guestbook_rate_events.user_id = p_user_id
    and guestbook_rate_events.created_at > v_now - interval '60 seconds';

  if v_recent_user > 0 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMIT:60';
  end if;

  select count(*) into v_recent_ip
  from public.guestbook_rate_events
  where guestbook_rate_events.ip_hash = p_ip_hash
    and guestbook_rate_events.created_at > v_now - interval '10 minutes';

  if v_recent_ip >= 6 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMIT:600';
  end if;

  delete from public.guestbook_rate_events
  where guestbook_rate_events.created_at < v_now - interval '24 hours';

  insert into public.guestbook_messages (
    nickname,
    message,
    country_name,
    region_name,
    created_at
  )
  values (
    p_nickname,
    p_message,
    coalesce(nullif(btrim(p_country), ''), '未知国家'),
    coalesce(nullif(btrim(p_region), ''), '未知地区'),
    v_now
  )
  returning guestbook_messages.id into v_message_id;

  insert into public.guestbook_message_private (message_id, user_id)
  values (v_message_id, p_user_id);

  insert into public.guestbook_rate_events (user_id, ip_hash, created_at)
  values (p_user_id, p_ip_hash, v_now);

  return query
  select g.id, g.nickname, g.message, g.country_name, g.region_name, g.created_at
  from public.guestbook_messages g
  where g.id = v_message_id;
end;
$$;

revoke all on function public.submit_guestbook_message(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_guestbook_message(uuid, text, text, text, text, text)
  to service_role;

alter table public.guestbook_messages replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'guestbook_messages'
  ) then
    alter publication supabase_realtime add table public.guestbook_messages;
  end if;
end;
$$;

create extension if not exists pg_cron with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'guestbook-rate-cleanup';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'guestbook-rate-cleanup',
    '27 3 * * *',
    $cron$delete from public.guestbook_rate_events where created_at < now() - interval '24 hours';$cron$
  );
end;
$$;

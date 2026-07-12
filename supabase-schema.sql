create table if not exists public.anime_tracker_payloads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.anime_tracker_payloads enable row level security;

create policy "users read own tracker payload"
on public.anime_tracker_payloads for select
using (auth.uid() = user_id);

create policy "users insert own tracker payload"
on public.anime_tracker_payloads for insert
with check (auth.uid() = user_id);

create policy "users update own tracker payload"
on public.anime_tracker_payloads for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "users delete own tracker payload"
on public.anime_tracker_payloads for delete
using (auth.uid() = user_id);

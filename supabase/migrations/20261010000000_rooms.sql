-- Server-only room storage. Player hands and session credentials must never be
-- fetched through the public browser key; the API returns a filtered view.
create table if not exists public.svintus_rooms (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  state jsonb not null,
  sessions jsonb not null,
  version integer not null default 0 check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.svintus_rooms enable row level security;
revoke all on table public.svintus_rooms from anon, authenticated;
grant select, insert, update, delete on table public.svintus_rooms to service_role;

-- version is used by the server API for atomic compare-and-swap updates.
-- There are deliberately no public RLS policies.
notify pgrst, 'reload schema';

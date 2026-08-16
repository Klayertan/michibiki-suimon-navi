-- スイスイナビ / SuisuiNavi — accounts and user-owned field data
--
-- Run this once against a fresh Supabase project (SQL Editor, or
-- `supabase db push`). It is idempotent: every object is created with
-- IF NOT EXISTS / CREATE OR REPLACE, and every policy is dropped before it is
-- recreated, so re-running it is safe.
--
-- SECURITY MODEL — read this before changing anything below.
--
--   1. Every user-owned table has `owner_id uuid not null default auth.uid()`.
--      The browser NEVER sends owner_id; the database fills it in.
--   2. Every table has RLS ENABLED with FORCE, and four policies whose USING
--      and WITH CHECK clauses are both `owner_id = auth.uid()`.
--        - USING      controls which rows a SELECT/UPDATE/DELETE can see.
--        - WITH CHECK controls what an INSERT/UPDATE is allowed to write.
--      Together they mean a request that names another farmer's owner_id is
--      rejected outright, and a request for another farmer's row id returns
--      nothing — not a 403 that confirms the row exists, just no row.
--   3. There is no policy for the `anon` role. An unauthenticated request
--      sees nothing, whatever it asks for.
--   4. Frontend filtering is NOT part of this model. The client code in
--      js/cloud/supabase-cloud-store.js deliberately does not add
--      `.eq("owner_id", …)` — if a query could return somebody else's row,
--      that is a bug to fix here, not to hide there.
--
-- DATA MODEL NOTE
--
-- Each table keeps the device's own record verbatim in a `record` jsonb
-- column, alongside denormalized columns (name / area_m2 / boundary / …) for
-- querying and for support. The blob is the authority on round-trip: the app
-- reconstructs a local record from `record` and never from the columns, so a
-- column drifting out of step can never corrupt a paddy boundary.
--
-- `legacy_*_id` holds the device-side identifier (`paddy-001`, …). It is the
-- sync matching key and is unique per owner; the cloud primary key is a UUID,
-- as required — a human-readable name is never a primary key here.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'One row per farmer. display_name is a label only and is never an authorization input.';

-- ---------------------------------------------------------------------------
-- fields — the registered paddy
-- ---------------------------------------------------------------------------

create table if not exists public.fields (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  legacy_field_id      text not null,
  name                 text not null default '',
  area_m2              double precision,
  source_nmea_filename text,
  -- [[lat, lon], …] in the device's Leaflet-first order. Denormalized for
  -- inspection; `record` is what the app reads back.
  boundary             jsonb not null default '[]'::jsonb,
  record               jsonb not null default '{}'::jsonb,
  -- The record's OWN properties.updatedAt at upload time. Conflicts compare
  -- this against the device's copy, so a client/server clock difference never
  -- decides which paddy boundary survives.
  local_updated_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint fields_owner_legacy_id_key unique (owner_id, legacy_field_id)
);

create index if not exists fields_owner_id_idx on public.fields (owner_id);

-- ---------------------------------------------------------------------------
-- water_control_points — 水門 / 給水口 / 排水口 / 水位センサ / 撮影地点
-- ---------------------------------------------------------------------------

create table if not exists public.water_control_points (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Nullable on purpose: the device's record links to a field through
  -- `relatedFieldId`, which may legitimately be null, and a point must not be
  -- lost because its field has not been uploaded yet.
  field_id         uuid references public.fields (id) on delete cascade,
  legacy_point_id  text not null,
  legacy_field_id  text,
  -- The exported long form the app already uses: water_gate / water_inlet /
  -- water_outlet / water_level_sensor / photo_point. Deliberately NOT an enum
  -- so a new type on the device cannot fail an upload.
  point_type       text not null,
  lat              double precision,
  lon              double precision,
  record           jsonb not null default '{}'::jsonb,
  local_updated_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint water_control_points_owner_legacy_id_key unique (owner_id, legacy_point_id)
);

create index if not exists water_control_points_owner_id_idx on public.water_control_points (owner_id);
create index if not exists water_control_points_field_id_idx on public.water_control_points (field_id);

-- ---------------------------------------------------------------------------
-- field_observations — 現地観察メモ (雑草 / 害虫 / 病気 / 水不足 …)
-- ---------------------------------------------------------------------------

create table if not exists public.field_observations (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
  field_id               uuid references public.fields (id) on delete cascade,
  legacy_observation_id  text not null,
  legacy_field_id        text,
  observation_type       text not null,
  severity               text,
  lat                    double precision,
  lon                    double precision,
  record                 jsonb not null default '{}'::jsonb,
  local_updated_at       timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint field_observations_owner_legacy_id_key unique (owner_id, legacy_observation_id)
);

create index if not exists field_observations_owner_id_idx on public.field_observations (owner_id);
create index if not exists field_observations_field_id_idx on public.field_observations (field_id);

-- ---------------------------------------------------------------------------
-- field_water_targets — the per-field 目標水位 used by the 適正 / 低め verdict
--
-- Its own table rather than a column on `fields` because on the device it is
-- its own storage key with its own lifetime (a farmer sets and clears it
-- without touching the paddy record), and folding it into the field record
-- would change a shape the whole app already depends on.
-- ---------------------------------------------------------------------------

create table if not exists public.field_water_targets (
  owner_id              uuid not null default auth.uid() references auth.users (id) on delete cascade,
  legacy_field_id       text not null,
  field_id              uuid references public.fields (id) on delete cascade,
  target_water_level_cm double precision,
  updated_at            timestamptz not null default now(),
  primary key (owner_id, legacy_field_id)
);

-- ---------------------------------------------------------------------------
-- NOT IN THIS MIGRATION, and why
--
--   raw NMEA text / survey sessions / recording sessions
--     A single walk can be megabytes, and the recording store also holds
--     image blobs. Uploading them would make the account feature slow and
--     expensive for no farmer-visible gain, so v1 keeps them on the device
--     and exportable. The cloud field row still carries the measurement
--     quality that matters -- source filename, point count and the
--     fixQualitySummary -- inside `record`.
--
--   water_measurements (session-child water-level readings)
--     Audited before designing this schema: on the device these live in the
--     IndexedDB recording store as `markedObservations`, keyed by a recording
--     session id, and creating one requires an active WebSerial connection to
--     the QZ1. They belong to the recording session, not to the paddy, so
--     they follow the recording data and stay local in v1. A table invented
--     for them now would be a guess about a Stage-2 shape.
--
--   boundary_tracks
--     A Settings-only legacy concept that the Stage-1 Basic flow can no
--     longer create. Kept local rather than given cloud ownership it does not
--     need.
--
-- All three are stated plainly in docs/STAGE1_AUTH_CLOUD_FIELDS.md so nobody
-- is left believing everything syncs.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists fields_set_updated_at on public.fields;
create trigger fields_set_updated_at
  before update on public.fields
  for each row execute function public.set_updated_at();

drop trigger if exists water_control_points_set_updated_at on public.water_control_points;
create trigger water_control_points_set_updated_at
  before update on public.water_control_points
  for each row execute function public.set_updated_at();

drop trigger if exists field_observations_set_updated_at on public.field_observations;
create trigger field_observations_set_updated_at
  before update on public.field_observations
  for each row execute function public.set_updated_at();

drop trigger if exists field_water_targets_set_updated_at on public.field_water_targets;
create trigger field_water_targets_set_updated_at
  before update on public.field_water_targets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- FORCE matters: without it the table owner (and anything connecting as it)
-- would bypass these policies.
-- ---------------------------------------------------------------------------

alter table public.profiles              enable row level security;
alter table public.profiles              force row level security;
alter table public.fields                enable row level security;
alter table public.fields                force row level security;
alter table public.water_control_points  enable row level security;
alter table public.water_control_points  force row level security;
alter table public.field_observations    enable row level security;
alter table public.field_observations    force row level security;
alter table public.field_water_targets   enable row level security;
alter table public.field_water_targets   force row level security;

-- profiles (keyed by user_id rather than owner_id)

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated using (user_id = (select auth.uid()));

-- fields

drop policy if exists fields_select_own on public.fields;
create policy fields_select_own on public.fields
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists fields_insert_own on public.fields;
create policy fields_insert_own on public.fields
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists fields_update_own on public.fields;
create policy fields_update_own on public.fields
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists fields_delete_own on public.fields;
create policy fields_delete_own on public.fields
  for delete to authenticated using (owner_id = (select auth.uid()));

-- water_control_points

drop policy if exists water_control_points_select_own on public.water_control_points;
create policy water_control_points_select_own on public.water_control_points
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists water_control_points_insert_own on public.water_control_points;
create policy water_control_points_insert_own on public.water_control_points
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists water_control_points_update_own on public.water_control_points;
create policy water_control_points_update_own on public.water_control_points
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists water_control_points_delete_own on public.water_control_points;
create policy water_control_points_delete_own on public.water_control_points
  for delete to authenticated using (owner_id = (select auth.uid()));

-- field_observations

drop policy if exists field_observations_select_own on public.field_observations;
create policy field_observations_select_own on public.field_observations
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists field_observations_insert_own on public.field_observations;
create policy field_observations_insert_own on public.field_observations
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists field_observations_update_own on public.field_observations;
create policy field_observations_update_own on public.field_observations
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists field_observations_delete_own on public.field_observations;
create policy field_observations_delete_own on public.field_observations
  for delete to authenticated using (owner_id = (select auth.uid()));

-- field_water_targets

drop policy if exists field_water_targets_select_own on public.field_water_targets;
create policy field_water_targets_select_own on public.field_water_targets
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists field_water_targets_insert_own on public.field_water_targets;
create policy field_water_targets_insert_own on public.field_water_targets
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists field_water_targets_update_own on public.field_water_targets;
create policy field_water_targets_update_own on public.field_water_targets
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists field_water_targets_delete_own on public.field_water_targets;
create policy field_water_targets_delete_own on public.field_water_targets
  for delete to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Create the profile row automatically on sign-up, so the app never has to
-- treat "profile missing" as a state.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

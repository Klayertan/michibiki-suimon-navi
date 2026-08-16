-- RLS verification for スイスイナビ accounts.
--
-- Run this in the Supabase SQL Editor AFTER applying
-- supabase/migrations/001_accounts_fields.sql and creating the two test users
-- described in docs/SUPABASE_SETUP.md §8.
--
-- It proves, at the database level, the property the brief calls
-- non-negotiable: User A cannot retrieve User B's fields by changing an id, a
-- parameter, or a JavaScript call. The browser is not involved at all here —
-- that is the point. Frontend filtering could pass a UI test while the data
-- was still readable; this cannot.
--
-- HOW IT WORKS: `set local role authenticated` plus a `request.jwt.claims`
-- setting is what PostgREST does per request, so `auth.uid()` inside the
-- policies resolves exactly as it does for a real signed-in farmer.
--
-- Every check RAISEs on failure, so a green run means every assertion held.

begin;

do $$
declare
  user_a uuid;
  user_b uuid;
  a_field_1 uuid;
  a_field_2 uuid;
  b_field_1 uuid;
  visible int;
  leaked int;
begin
  select id into user_a from auth.users where email = 'farmer-a@example.test';
  select id into user_b from auth.users where email = 'farmer-b@example.test';

  if user_a is null or user_b is null then
    raise exception 'Create farmer-a@example.test and farmer-b@example.test first (docs/SUPABASE_SETUP.md §8).';
  end if;

  -- -------------------------------------------------------------------------
  -- Seed as User A: two paddies.
  -- -------------------------------------------------------------------------
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  insert into public.fields (legacy_field_id, name, area_m2, boundary, record, local_updated_at)
  values ('paddy-001', '北田', 4286,
          '[[34.65,135.83],[34.651,135.83],[34.651,135.831]]'::jsonb,
          '{"id":"paddy-001","name":"北田"}'::jsonb, now())
  on conflict (owner_id, legacy_field_id) do update set name = excluded.name
  returning id into a_field_1;

  insert into public.fields (legacy_field_id, name, area_m2, boundary, record, local_updated_at)
  values ('paddy-002', '南田', 3910,
          '[[34.64,135.83],[34.641,135.83],[34.641,135.831]]'::jsonb,
          '{"id":"paddy-002","name":"南田"}'::jsonb, now())
  on conflict (owner_id, legacy_field_id) do update set name = excluded.name
  returning id into a_field_2;

  -- owner_id must have been filled in by the DEFAULT, not by the client.
  if (select owner_id from public.fields where id = a_field_1) <> user_a then
    raise exception 'FAIL: owner_id default did not resolve to auth.uid()';
  end if;

  -- -------------------------------------------------------------------------
  -- Seed as User B: one paddy, deliberately reusing the SAME legacy id.
  -- The unique constraint is (owner_id, legacy_field_id), so this must be
  -- allowed and must not collide with User A's paddy-001.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', user_b, 'role', 'authenticated')::text, true);

  insert into public.fields (legacy_field_id, name, area_m2, boundary, record, local_updated_at)
  values ('paddy-001', 'B農園 東田', 5120,
          '[[34.60,135.80],[34.601,135.80],[34.601,135.801]]'::jsonb,
          '{"id":"paddy-001","name":"B農園 東田"}'::jsonb, now())
  on conflict (owner_id, legacy_field_id) do update set name = excluded.name
  returning id into b_field_1;

  -- B sees exactly one field.
  select count(*) into visible from public.fields;
  if visible <> 1 then
    raise exception 'FAIL: user B sees % fields, expected 1', visible;
  end if;

  -- CROSS-USER READ BY PRIMARY KEY: the exact "change the field ID" attack.
  select count(*) into leaked from public.fields where id in (a_field_1, a_field_2);
  if leaked <> 0 then
    raise exception 'FAIL: user B read % of user A''s fields by id', leaked;
  end if;

  -- CROSS-USER UPDATE: silently affects zero rows rather than another
  -- farmer's boundary.
  update public.fields set name = 'HIJACKED' where id = a_field_1;
  get diagnostics leaked = row_count;
  if leaked <> 0 then
    raise exception 'FAIL: user B updated user A''s field';
  end if;

  -- CROSS-USER DELETE.
  delete from public.fields where id = a_field_2;
  get diagnostics leaked = row_count;
  if leaked <> 0 then
    raise exception 'FAIL: user B deleted user A''s field';
  end if;

  -- OWNER SPOOFING: naming another farmer as the owner must be refused by
  -- the WITH CHECK clause, not quietly rewritten.
  begin
    insert into public.fields (owner_id, legacy_field_id, name, record, local_updated_at)
    values (user_a, 'paddy-999', 'spoofed', '{"id":"paddy-999"}'::jsonb, now());
    raise exception 'FAIL: user B inserted a row owned by user A';
  exception
    when insufficient_privilege then
      null; -- expected
  end;

  -- -------------------------------------------------------------------------
  -- Back to User A: still exactly two fields, untouched.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', user_a, 'role', 'authenticated')::text, true);

  select count(*) into visible from public.fields;
  if visible <> 2 then
    raise exception 'FAIL: user A sees % fields, expected 2', visible;
  end if;
  if exists (select 1 from public.fields where name = 'HIJACKED') then
    raise exception 'FAIL: user A''s field was modified by user B';
  end if;

  -- -------------------------------------------------------------------------
  -- Anonymous: nothing, on every table.
  -- -------------------------------------------------------------------------
  set local role anon;
  perform set_config('request.jwt.claims', null, true);

  select count(*) into leaked from public.fields;
  if leaked <> 0 then
    raise exception 'FAIL: anonymous read % fields', leaked;
  end if;
  select count(*) into leaked from public.water_control_points;
  if leaked <> 0 then
    raise exception 'FAIL: anonymous read % water control points', leaked;
  end if;
  select count(*) into leaked from public.field_observations;
  if leaked <> 0 then
    raise exception 'FAIL: anonymous read % observations', leaked;
  end if;
  select count(*) into leaked from public.field_water_targets;
  if leaked <> 0 then
    raise exception 'FAIL: anonymous read % water targets', leaked;
  end if;
  select count(*) into leaked from public.profiles;
  if leaked <> 0 then
    raise exception 'FAIL: anonymous read % profiles', leaked;
  end if;

  reset role;
  raise notice 'PASS: all RLS assertions held.';
end;
$$;

-- Nothing is kept: this is a verification run, not a fixture.
rollback;

\set ON_ERROR_STOP on

begin;

create function public.sd407_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'assertion failed: %', p_message; end if;
end $$;

create function public.sd407_document(
  p_nda uuid, p_version uuid, p_number integer,
  p_signer_a uuid, p_party_a uuid, p_signer_b uuid, p_party_b uuid
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'canonical_schema', 'signdee.nda.document.v1',
    'nda_id', p_nda::text, 'version_id', p_version::text, 'version_number', p_number,
    'parties', jsonb_build_array(
      jsonb_build_object('signer_id', p_signer_a::text, 'party_ref', p_party_a::text, 'role', 'discloser'),
      jsonb_build_object('signer_id', p_signer_b::text, 'party_ref', p_party_b::text, 'role', 'recipient')
    ),
    'title', 'Local authority database test', 'clauses', jsonb_build_array('one','two')
  )
$$;

create function public.sd407_create_initial(
  p_nda uuid, p_version uuid, p_signer_a uuid, p_party_a uuid,
  p_signer_b uuid, p_party_b uuid, p_digest_a text, p_digest_b text
) returns void language plpgsql as $$
declare d jsonb;
begin
  d := public.sd407_document(p_nda, p_version, 1, p_signer_a, p_party_a, p_signer_b, p_party_b);
  perform public.nda_authority_create_initial_version(
    p_nda, p_version, 'signdee.nda.document.v1', d::text, d,
    encode(extensions.digest(convert_to(d::text, 'UTF8'), 'sha256'), 'hex'),
    jsonb_build_array(
      jsonb_build_object('id', p_signer_a, 'party_ref', p_party_a, 'role', 'discloser',
        'capability_digest', p_digest_a, 'expires_at', '2099-01-01T00:00:00Z'),
      jsonb_build_object('id', p_signer_b, 'party_ref', p_party_b, 'role', 'recipient',
        'capability_digest', p_digest_b, 'expires_at', '2099-01-01T00:00:00Z')
    )
  );
end $$;

create function public.sd407_expect_sign_failure(
  p_nda uuid, p_version uuid, p_signer uuid, p_digest text, p_label text
) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin
    perform public.nda_authority_sign_version(
      p_nda, p_version, p_signer, p_digest, 'signdee.nda.signing-consent.v1');
  exception when others then
    failed := true;
  end;
  if not failed then raise exception 'expected signing failure: %', p_label; end if;
end $$;

-- Schema, hardening, and grant proof.
select public.sd407_assert(
  (select count(*) = 5 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in (
     'nda_authority_contracts','nda_authority_versions','nda_authority_signers',
     'nda_authority_capabilities','nda_authority_audit_events') and c.relkind = 'r'),
  'all five authority tables exist');
select public.sd407_assert(
  (select count(*) = 5 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname like 'nda_authority_%'
     and c.relname in ('nda_authority_contracts','nda_authority_versions','nda_authority_signers',
       'nda_authority_capabilities','nda_authority_audit_events') and c.relrowsecurity),
  'RLS enabled on every authority table');
select public.sd407_assert(
  has_function_privilege('service_role',
    'public.nda_authority_sign_version(uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'service_role can execute signing RPC');
select public.sd407_assert(
  not has_function_privilege('anon',
    'public.nda_authority_sign_version(uuid,uuid,uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.nda_authority_sign_version(uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'browser roles cannot execute signing RPC');
select public.sd407_assert(
  (select prosecdef and proconfig @> array['search_path=public, pg_temp']
   from pg_proc where oid = 'public.nda_authority_sign_version(uuid,uuid,uuid,text,text)'::regprocedure),
  'signing RPC is security definer with fixed search_path');
select public.sd407_assert(
  (select count(*) >= 9 from pg_constraint
   where conrelid in ('public.nda_authority_versions'::regclass,
     'public.nda_authority_signers'::regclass,
     'public.nda_authority_capabilities'::regclass,
     'public.nda_authority_audit_events'::regclass)),
  'authority constraints exist');
select public.sd407_assert(
  (select count(*) >= 5 from pg_indexes where schemaname = 'public'
    and indexname like 'nda_authority_%'), 'authority indexes exist');

do $$
declare denied boolean := false;
begin
  begin
    execute 'set local role anon';
    perform count(*) from public.nda_authority_versions;
  exception when insufficient_privilege then denied := true;
  end;
  execute 'reset role';
  perform public.sd407_assert(denied, 'anon direct read denied');
end $$;
do $$
declare denied boolean := false;
begin
  begin
    execute 'set local role authenticated';
    insert into public.nda_authority_contracts(id) values ('90000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then denied := true;
  end;
  execute 'reset role';
  perform public.sd407_assert(denied, 'authenticated direct mutation denied');
end $$;
do $$
declare denied boolean := false;
begin
  begin
    execute 'set local role service_role';
    insert into public.nda_authority_contracts(id) values ('90000000-0000-4000-8000-000000000002');
  exception when insufficient_privilege then denied := true;
  end;
  execute 'reset role';
  perform public.sd407_assert(denied, 'service_role direct mutation denied');
end $$;

-- Contract A: exact binding, first/final signer completion, and replay.
set local role service_role;
select public.sd407_create_initial(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006',
  repeat('11',32), repeat('22',32));
reset role;

-- All substitution and digest failures occur before mutation.
set local role service_role;
select public.sd407_expect_sign_failure(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',repeat('ff',32),'digest mismatch');
select public.sd407_expect_sign_failure(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000005',repeat('11',32),'cross signer');
select public.sd407_expect_sign_failure(
  '20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',repeat('11',32),'cross NDA');
select public.sd407_expect_sign_failure(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000003',repeat('11',32),'cross version');
select public.nda_authority_sign_version(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',repeat('11',32),
  'signdee.nda.signing-consent.v1');
reset role;

select public.sd407_assert(
  (select lifecycle_status = 'issued' and completed_at is null
   from public.nda_authority_versions where id = '10000000-0000-4000-8000-000000000002'),
  'first signer does not complete version');
select public.sd407_assert(
  (select signing_status = 'signed' and signed_at is not null
    and octet_length(signing_evidence_digest) = 32
   from public.nda_authority_signers where id = '10000000-0000-4000-8000-000000000003'),
  'first signer evidence recorded');
select public.sd407_assert(
  (select status = 'consumed' and consumed_at is not null
   from public.nda_authority_capabilities where signer_id = '10000000-0000-4000-8000-000000000003'),
  'first capability atomically consumed');

set local role service_role;
select public.sd407_expect_sign_failure(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',repeat('11',32),'consumed replay');
select public.nda_authority_sign_version(
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000005',repeat('22',32),
  'signdee.nda.signing-consent.v1');
reset role;

select public.sd407_assert(
  (select lifecycle_status = 'completed' and completed_at is not null
   from public.nda_authority_versions where id = '10000000-0000-4000-8000-000000000002'),
  'final same-version signer completes version');
select public.sd407_assert(
  (select lifecycle_status = 'completed'
    and completed_version_id = '10000000-0000-4000-8000-000000000002'
   from public.nda_authority_contracts where id = '10000000-0000-4000-8000-000000000001'),
  'exact parent contract completes');
select public.sd407_assert(
  (select count(*) = 1 from public.nda_authority_audit_events
   where nda_id = '10000000-0000-4000-8000-000000000001' and event_type = 'version.completed'),
  'one version completion audit event');
select public.sd407_assert(
  (select count(*) = 2 from public.nda_authority_audit_events
   where nda_id = '10000000-0000-4000-8000-000000000001' and event_type = 'signer.signed'),
  'one signing audit event per signer');

-- Contract B: revoked and terminal void rejection.
set local role service_role;
select public.sd407_create_initial(
  '20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000006',
  repeat('33',32), repeat('44',32));
select public.nda_authority_invalidate_version(
  '20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
  'void','local test',null);
select public.sd407_expect_sign_failure(
  '20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',repeat('33',32),'voided version');
reset role;
select public.sd407_assert(
  (select bool_and(status = 'revoked' and revoked_at is not null)
   from public.nda_authority_capabilities where nda_id = '20000000-0000-4000-8000-000000000001'),
  'invalidation revoked every active capability');

-- Contract C: expired and explicitly revoked capabilities are rejected.
set local role service_role;
select public.sd407_create_initial(
  '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000006',
  repeat('55',32), repeat('66',32));
reset role;
update public.nda_authority_capabilities
set created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour'
where signer_id = '30000000-0000-4000-8000-000000000003';
update public.nda_authority_capabilities
set status = 'revoked', revoked_at = clock_timestamp()
where signer_id = '30000000-0000-4000-8000-000000000005';
set local role service_role;
select public.sd407_expect_sign_failure(
  '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',repeat('55',32),'expired capability');
select public.sd407_expect_sign_failure(
  '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000005',repeat('66',32),'revoked capability');
reset role;

-- Contract D: forced audit failure proves rollback after signer/capability mutation.
set local role service_role;
select public.sd407_create_initial(
  '40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000004',
  '40000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000006',
  repeat('77',32), repeat('88',32));
reset role;
create function public.sd407_force_audit_failure() returns trigger language plpgsql as $$
begin
  if new.nda_id = '40000000-0000-4000-8000-000000000001' and new.event_type = 'signer.signed'
  then raise exception 'forced local rollback proof'; end if;
  return new;
end $$;
create trigger sd407_force_audit_failure before insert on public.nda_authority_audit_events
for each row execute function public.sd407_force_audit_failure();
set local role service_role;
select public.sd407_expect_sign_failure(
  '40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',repeat('77',32),'forced rollback');
reset role;
drop trigger sd407_force_audit_failure on public.nda_authority_audit_events;
drop function public.sd407_force_audit_failure();
select public.sd407_assert(
  (select signing_status = 'pending' and signed_at is null
   from public.nda_authority_signers where id = '40000000-0000-4000-8000-000000000003'),
  'failed transaction rolled back signer');
select public.sd407_assert(
  (select status = 'active' and consumed_at is null
   from public.nda_authority_capabilities where signer_id = '40000000-0000-4000-8000-000000000003'),
  'failed transaction rolled back capability');
select public.sd407_assert(
  (select lifecycle_status = 'issued' from public.nda_authority_versions
   where id = '40000000-0000-4000-8000-000000000002'),
  'failed transaction left lifecycle issued');
select public.sd407_assert(
  not exists (select 1 from public.nda_authority_audit_events
   where nda_id = '40000000-0000-4000-8000-000000000001' and event_type = 'signer.signed'),
  'failed transaction left no signing audit');

-- Contract E: a signature on version 1 cannot count for version 2, and a
-- superseded version cannot accept another signature.
set local role service_role;
select public.sd407_create_initial(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000004',
  '50000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000006',
  repeat('99',32), repeat('aa',32));
select public.nda_authority_sign_version(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003',repeat('99',32),
  'signdee.nda.signing-consent.v1');
reset role;
do $$
declare d jsonb;
begin
  d := public.sd407_document(
    '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000012',2,
    '50000000-0000-4000-8000-000000000013','50000000-0000-4000-8000-000000000014',
    '50000000-0000-4000-8000-000000000015','50000000-0000-4000-8000-000000000016');
  insert into public.nda_authority_versions(
    id,nda_id,version_number,canonical_schema,canonical_payload,canonical_document,
    document_hash,lifecycle_status,issued_at)
  values (
    '50000000-0000-4000-8000-000000000012','50000000-0000-4000-8000-000000000001',2,
    'signdee.nda.document.v1',d::text,d,
    extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'issued',clock_timestamp());
  insert into public.nda_authority_signers(id,nda_id,version_id,party_ref,signer_role,signing_order)
  values
    ('50000000-0000-4000-8000-000000000013','50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000012','50000000-0000-4000-8000-000000000014','discloser',1),
    ('50000000-0000-4000-8000-000000000015','50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000012','50000000-0000-4000-8000-000000000016','recipient',2);
  insert into public.nda_authority_capabilities(nda_id,version_id,signer_id,capability_digest,expires_at)
  values
    ('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000012',
      '50000000-0000-4000-8000-000000000013',decode(repeat('bb',32),'hex'),'2099-01-01T00:00:00Z'),
    ('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000012',
      '50000000-0000-4000-8000-000000000015',decode(repeat('cc',32),'hex'),'2099-01-01T00:00:00Z');
end $$;
set local role service_role;
select public.nda_authority_invalidate_version(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',
  'superseded','replacement issued','50000000-0000-4000-8000-000000000012');
select public.sd407_expect_sign_failure(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000005',repeat('aa',32),'superseded version');
select public.nda_authority_sign_version(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000012',
  '50000000-0000-4000-8000-000000000013',repeat('bb',32),
  'signdee.nda.signing-consent.v1');
reset role;
select public.sd407_assert(
  (select lifecycle_status = 'issued' from public.nda_authority_versions
   where id = '50000000-0000-4000-8000-000000000012'),
  'signature from older version did not complete replacement version');
select public.sd407_assert(
  (select count(*) = 1 from public.nda_authority_signers
   where nda_id = '50000000-0000-4000-8000-000000000001'
     and version_id = '50000000-0000-4000-8000-000000000012'
     and is_required and signing_status = 'signed'),
  'completion count is restricted to replacement version');
set local role service_role;
select public.nda_authority_sign_version(
  '50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000012',
  '50000000-0000-4000-8000-000000000015',repeat('cc',32),
  'signdee.nda.signing-consent.v1');
reset role;
select public.sd407_assert(
  (select lifecycle_status = 'completed' from public.nda_authority_versions
   where id = '50000000-0000-4000-8000-000000000012'),
  'replacement completes only after its own final required signer');

-- Database constraints/guards reject canonical mutation, completion bypass,
-- mismatched audit relations, and audit modification.
do $$ begin
  begin
    update public.nda_authority_versions set canonical_payload = canonical_payload || ' '
    where id = '40000000-0000-4000-8000-000000000002';
    raise exception 'canonical mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'canonical mutation unexpectedly succeeded' then raise; end if;
  end;
end $$;
do $$ begin
  begin
    update public.nda_authority_versions set lifecycle_status = 'completed', completed_at = clock_timestamp()
    where id = '40000000-0000-4000-8000-000000000002';
    raise exception 'premature completion unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'premature completion unexpectedly succeeded' then raise; end if;
  end;
end $$;
do $$ begin
  begin
    insert into public.nda_authority_audit_events(nda_id,version_id,signer_id,event_type)
    values ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000003','signer.signed');
    raise exception 'mismatched audit unexpectedly succeeded';
  exception when foreign_key_violation then null;
  end;
end $$;
do $$ begin
  begin
    update public.nda_authority_audit_events set event_data = '{"changed":true}'
    where nda_id = '10000000-0000-4000-8000-000000000001';
    raise exception 'audit mutation unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'audit mutation unexpectedly succeeded' then raise; end if;
  end;
end $$;

-- Persistence has a digest only and audit metadata has no capability/signature payload.
select public.sd407_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name like 'nda_authority_%'
      and column_name ~ '(plaintext|token|signature_image|base64|raw_capability)'
  ), 'no plaintext capability or visual signature persistence columns');
select public.sd407_assert(
  not exists (
    select 1 from public.nda_authority_audit_events
    where event_data::text ~* '(capability|signature_image|base64|secret)'
  ), 'audit metadata contains no prohibited signing material');

drop function public.sd407_expect_sign_failure(uuid,uuid,uuid,text,text);
drop function public.sd407_create_initial(uuid,uuid,uuid,uuid,uuid,uuid,text,text);
drop function public.sd407_document(uuid,uuid,integer,uuid,uuid,uuid,uuid);
drop function public.sd407_assert(boolean,text);

rollback;

\echo 'SD-407A.2B database assertions passed: 36'

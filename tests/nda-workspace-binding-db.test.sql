\set ON_ERROR_STOP on

begin;

create function public.sd407b_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then raise exception 'assertion failed: %', p_message; end if;
end $$;

create function public.sd407b_document(
  p_nda uuid, p_version uuid, p_number integer,
  p_signer_a uuid, p_party_a uuid, p_signer_b uuid, p_party_b uuid
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'canonical_schema', 'signdee.nda.document.v1',
    'nda_id', p_nda::text, 'version_id', p_version::text, 'version_number', p_number,
    'parties', jsonb_build_array(
      jsonb_build_object('signer_id', p_signer_a::text, 'party_ref', p_party_a::text, 'role', 'discloser'),
      jsonb_build_object('signer_id', p_signer_b::text, 'party_ref', p_party_b::text, 'role', 'recipient')
    ), 'title', 'Workspace binding authority test', 'clauses', jsonb_build_array('one','two')
  )
$$;

create function public.sd407b_create_initial(
  p_nda uuid, p_version uuid, p_signer_a uuid, p_party_a uuid,
  p_signer_b uuid, p_party_b uuid, p_digest_a text, p_digest_b text
) returns void language plpgsql as $$
declare d jsonb;
begin
  d := public.sd407b_document(p_nda,p_version,1,p_signer_a,p_party_a,p_signer_b,p_party_b);
  perform public.nda_authority_create_initial_version(
    p_nda,p_version,'signdee.nda.document.v1',d::text,d,
    encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex'),
    jsonb_build_array(
      jsonb_build_object('id',p_signer_a,'party_ref',p_party_a,'role','discloser',
        'capability_digest',p_digest_a,'expires_at','2099-01-01T00:00:00Z'),
      jsonb_build_object('id',p_signer_b,'party_ref',p_party_b,'role','recipient',
        'capability_digest',p_digest_b,'expires_at','2099-01-01T00:00:00Z')
    )
  );
end $$;

create function public.sd407b_complete(
  p_nda uuid, p_version uuid, p_signer_a uuid, p_signer_b uuid,
  p_digest_a text, p_digest_b text
) returns void language plpgsql as $$
begin
  perform public.nda_authority_sign_version(
    p_nda,p_version,p_signer_a,p_digest_a,'signdee.nda.signing-consent.v1');
  perform public.nda_authority_sign_version(
    p_nda,p_version,p_signer_b,p_digest_b,'signdee.nda.signing-consent.v1');
end $$;

create function public.sd407b_expect_reservation_failure(
  p_nda uuid, p_version uuid, p_workspace uuid, p_label text
) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin
    perform public.nda_authority_reserve_workspace_binding(
      p_nda,p_version,p_workspace,'workspace-adapter:v1');
  exception when others then failed := true;
  end;
  if not failed then raise exception 'expected reservation failure: %', p_label; end if;
end $$;

select public.sd407b_assert(
  (select count(*) = 2 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname in (
     'nda_workspace_binding_authorities','nda_workspace_binding_audit_events') and c.relkind='r'),
  'binding authority tables exist');
select public.sd407b_assert(
  (select bool_and(relrowsecurity) from pg_class
   where oid in ('public.nda_workspace_binding_authorities'::regclass,
     'public.nda_workspace_binding_audit_events'::regclass)),
  'binding RLS enabled');
select public.sd407b_assert(
  has_function_privilege('service_role',
    'public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('anon',
    'public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)','EXECUTE'),
  'only service_role executes reservation RPC');
select public.sd407b_assert(
  (select prosecdef and proconfig @> array['search_path=public, pg_temp']
   from pg_proc where oid =
     'public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)'::regprocedure),
  'reservation RPC hardened');

do $$ declare denied boolean := false; begin
  begin execute 'set local role anon'; perform count(*) from public.nda_workspace_binding_authorities;
  exception when insufficient_privilege then denied := true; end;
  execute 'reset role'; perform public.sd407b_assert(denied,'anon read denied');
end $$;
do $$ declare denied boolean := false; begin
  begin execute 'set local role authenticated';
    insert into public.nda_workspace_binding_authorities(
      nda_id,version_id,workspace_id,document_hash,authority_package_reference,
      actor_principal,reservation_key)
    values (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),decode(repeat('00',32),'hex'),
      'nda-authority:x/y','x', 'ndawb_'||repeat('0',64));
  exception when insufficient_privilege then denied := true; end;
  execute 'reset role'; perform public.sd407b_assert(denied,'authenticated mutation denied');
end $$;
do $$ declare denied boolean := false; begin
  begin execute 'set local role service_role';
    delete from public.nda_workspace_binding_authorities;
  exception when insufficient_privilege then denied := true; end;
  execute 'reset role'; perform public.sd407b_assert(denied,'service_role direct mutation denied');
end $$;

-- Merely issued, missing-signer, and browser-completion claims cannot reserve.
set local role service_role;
select public.sd407b_create_initial(
  '71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000004',
  '71000000-0000-4000-8000-000000000005','71000000-0000-4000-8000-000000000006',
  repeat('11',32),repeat('12',32));
select public.sd407b_expect_reservation_failure(
  '71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000007','issued and required signer missing');
select public.sd407b_expect_reservation_failure(
  '71000000-0000-4000-8000-000000000099','71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000007','cross NDA');
reset role;

-- Completed authority A: create, same-target replay, different-target conflict.
set local role service_role;
select public.sd407b_create_initial(
  '72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000004',
  '72000000-0000-4000-8000-000000000005','72000000-0000-4000-8000-000000000006',
  repeat('21',32),repeat('22',32));
select public.sd407b_complete(
  '72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000005',
  repeat('21',32),repeat('22',32));
select public.nda_authority_reserve_workspace_binding(
  '72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000007','workspace-adapter:v1');
select public.nda_authority_reserve_workspace_binding(
  '72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000007','workspace-adapter:v1');
select public.nda_authority_reserve_workspace_binding(
  '72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000008','workspace-adapter:v1');
reset role;

select public.sd407b_assert(
  (select count(*)=1 and bool_and(binding_status='reserved')
   from public.nda_workspace_binding_authorities
   where nda_id='72000000-0000-4000-8000-000000000001'),
  'exactly one reserved binding');
select public.sd407b_assert(
  (select workspace_id='72000000-0000-4000-8000-000000000007'
     and document_hash=(select document_hash from public.nda_authority_versions
       where id='72000000-0000-4000-8000-000000000002')
   from public.nda_workspace_binding_authorities
   where nda_id='72000000-0000-4000-8000-000000000001'),
  'binding target and canonical hash are authoritative');
select public.sd407b_assert(
  (select count(*)=1 from public.nda_workspace_binding_audit_events
   where nda_id='72000000-0000-4000-8000-000000000001'
     and event_type='workspace_binding.reserved'),
  'one successful reservation transition');
select public.sd407b_assert(
  (select count(*)=1 from public.nda_workspace_binding_audit_events
   where nda_id='72000000-0000-4000-8000-000000000001'
     and event_type='workspace_binding.idempotent_replay'),
  'same-target replay audited');
select public.sd407b_assert(
  (select count(*)=1 from public.nda_workspace_binding_audit_events
   where nda_id='72000000-0000-4000-8000-000000000001'
     and requested_workspace_id='72000000-0000-4000-8000-000000000008'
     and event_type='workspace_binding.conflict'),
  'different-target conflict audited');

-- Voided authority cannot reserve.
set local role service_role;
select public.sd407b_create_initial(
  '73000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002',
  '73000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000004',
  '73000000-0000-4000-8000-000000000005','73000000-0000-4000-8000-000000000006',
  repeat('31',32),repeat('32',32));
select public.nda_authority_invalidate_version(
  '73000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002',
  'void','binding negative test',null);
select public.sd407b_expect_reservation_failure(
  '73000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002',
  '73000000-0000-4000-8000-000000000007','void version');
reset role;

-- Superseded authority cannot reserve.
set local role service_role;
select public.sd407b_create_initial(
  '76000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000003','76000000-0000-4000-8000-000000000004',
  '76000000-0000-4000-8000-000000000005','76000000-0000-4000-8000-000000000006',
  repeat('61',32),repeat('62',32));
reset role;
do $$ declare d jsonb; begin
  d := public.sd407b_document(
    '76000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000012',2,
    '76000000-0000-4000-8000-000000000013','76000000-0000-4000-8000-000000000014',
    '76000000-0000-4000-8000-000000000015','76000000-0000-4000-8000-000000000016');
  insert into public.nda_authority_versions(
    id,nda_id,version_number,canonical_schema,canonical_payload,canonical_document,
    document_hash,lifecycle_status,issued_at)
  values ('76000000-0000-4000-8000-000000000012','76000000-0000-4000-8000-000000000001',2,
    'signdee.nda.document.v1',d::text,d,extensions.digest(convert_to(d::text,'UTF8'),'sha256'),
    'issued',clock_timestamp());
end $$;
set local role service_role;
select public.nda_authority_invalidate_version(
  '76000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000002',
  'superseded','binding negative test','76000000-0000-4000-8000-000000000012');
select public.sd407b_expect_reservation_failure(
  '76000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000007','superseded version');
reset role;

-- Draft authority cannot reserve.
do $$ declare d jsonb; begin
  insert into public.nda_authority_contracts(id)
  values ('74000000-0000-4000-8000-000000000001');
  d := public.sd407b_document(
    '74000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000002',1,
    '74000000-0000-4000-8000-000000000003','74000000-0000-4000-8000-000000000004',
    '74000000-0000-4000-8000-000000000005','74000000-0000-4000-8000-000000000006');
  insert into public.nda_authority_versions(
    id,nda_id,version_number,canonical_schema,canonical_payload,canonical_document,
    document_hash,lifecycle_status)
  values ('74000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000001',1,
    'signdee.nda.document.v1',d::text,d,extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'draft');
end $$;
set local role service_role;
select public.sd407b_expect_reservation_failure(
  '74000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000002',
  '74000000-0000-4000-8000-000000000007','draft version');
reset role;

-- Exact hash FK and canonical immutability reject forged hash state.
do $$ begin
  begin
    insert into public.nda_workspace_binding_authorities(
      nda_id,version_id,workspace_id,document_hash,authority_package_reference,
      actor_principal,reservation_key)
    values ('71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002',
      '71000000-0000-4000-8000-000000000009',decode(repeat('ff',32),'hex'),
      'nda-authority:71000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000002',
      'workspace-adapter:v1','ndawb_'||repeat('f',64));
    raise exception 'forged hash unexpectedly accepted';
  exception when foreign_key_violation then null;
  end;
end $$;
do $$ begin
  begin
    update public.nda_authority_versions set canonical_payload=canonical_payload||' '
    where id='72000000-0000-4000-8000-000000000002';
    raise exception 'canonical mutation unexpectedly accepted';
  exception when others then
    if sqlerrm='canonical mutation unexpectedly accepted' then raise; end if;
  end;
end $$;

-- Audit failure rolls back the binding insert.
set local role service_role;
select public.sd407b_create_initial(
  '75000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000002',
  '75000000-0000-4000-8000-000000000003','75000000-0000-4000-8000-000000000004',
  '75000000-0000-4000-8000-000000000005','75000000-0000-4000-8000-000000000006',
  repeat('51',32),repeat('52',32));
select public.sd407b_complete(
  '75000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000002',
  '75000000-0000-4000-8000-000000000003','75000000-0000-4000-8000-000000000005',
  repeat('51',32),repeat('52',32));
reset role;
create function public.sd407b_force_audit_failure() returns trigger language plpgsql as $$
begin
  if new.nda_id='75000000-0000-4000-8000-000000000001'
  then raise exception 'forced binding audit failure'; end if;
  return new;
end $$;
create trigger sd407b_force_audit_failure before insert on public.nda_workspace_binding_audit_events
for each row execute function public.sd407b_force_audit_failure();
set local role service_role;
select public.sd407b_expect_reservation_failure(
  '75000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000002',
  '75000000-0000-4000-8000-000000000007','forced audit rollback');
reset role;
drop trigger sd407b_force_audit_failure on public.nda_workspace_binding_audit_events;
drop function public.sd407b_force_audit_failure();
select public.sd407b_assert(
  not exists(select 1 from public.nda_workspace_binding_authorities
    where nda_id='75000000-0000-4000-8000-000000000001'),
  'audit failure rolled back binding');

do $$ begin
  begin
    update public.nda_workspace_binding_audit_events set actor_principal='changed'
    where nda_id='72000000-0000-4000-8000-000000000001';
    raise exception 'audit mutation unexpectedly accepted';
  exception when others then
    if sqlerrm='audit mutation unexpectedly accepted' then raise; end if;
  end;
end $$;

select public.sd407b_assert(
  not exists(select 1 from information_schema.columns
    where table_schema='public' and table_name like 'nda_workspace_binding_%'
      and column_name ~ '(capability|signature|payload|certificate|national_id|pii)'),
  'binding persistence contains no prohibited evidence columns');

drop function public.sd407b_expect_reservation_failure(uuid,uuid,uuid,text);
drop function public.sd407b_complete(uuid,uuid,uuid,uuid,text,text);
drop function public.sd407b_create_initial(uuid,uuid,uuid,uuid,uuid,uuid,text,text);
drop function public.sd407b_document(uuid,uuid,integer,uuid,uuid,uuid,uuid);
drop function public.sd407b_assert(boolean,text);

rollback;

\echo 'SD-407B.1 database assertions passed: 26'

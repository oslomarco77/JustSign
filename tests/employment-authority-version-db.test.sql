\set ON_ERROR_STOP on
begin;

insert into public.emp_contracts(id,contract_no,status,position_th,employment_type,salary,
  work_days,party_a,party_b,jd,clauses,updated_at)
values('82000000-0000-4000-8000-000000000001','EMP-DB-1','generated','วิศวกร','full_time',30000,
  '["mon","tue"]','{"name":"Employer"}','{"name":"Employee"}',
  '{"responsibilities":["work"],"qualifications":[],"kpis":[]}',
  (select jsonb_object_agg('c'||n,n||'. clause') from generate_series(1,18)n),
  '2026-08-06T01:00:00Z');

do $$begin
  if exists(select 1 from public.employment_authority_contracts
    where legacy_contract_id='82000000-0000-4000-8000-000000000001')
    then raise exception 'legacy row auto-promoted';end if;
end$$;

select updated_at source_updated_at from public.emp_contracts
where id='82000000-0000-4000-8000-000000000001' \gset

select '{"document_header":{"title":"legitimate A"}}' source_payload \gset
select encode(extensions.digest(convert_to(:'source_payload','UTF8'),'sha256'),'hex') source_digest \gset

set local role service_role;
select public.employment_authority_prepare_version(
  '82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000003',:'source_updated_at','signdee.employment.document.v1',
  :'source_payload',:'source_digest') r \gset
reset role;

create temporary table employment_canonical_fixture as select d,d::text payload,
  encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex') hash from (select
  jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id','82000000-0000-4000-8000-000000000002','legacy_contract_id','82000000-0000-4000-8000-000000000001',
    'version_id','82000000-0000-4000-8000-000000000003','version_number',1),
    'document_header',jsonb_build_object('title','legitimate A')) d)s;
grant select on employment_canonical_fixture to service_role;
set local role service_role;
select public.employment_authority_issue_version('82000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000003',:'source_updated_at','signdee.employment.document.v1',
    payload,d,hash) from employment_canonical_fixture;
reset role;

do $$begin
  if (select lifecycle_status from public.employment_authority_versions
    where id='82000000-0000-4000-8000-000000000003')<>'issued' then raise exception 'not issued';end if;
  if (select count(*) from public.employment_authority_contracts)<>1 then raise exception 'legacy promoted unexpectedly';end if;
end$$;

do $$begin begin
  update public.employment_authority_versions set document_hash=decode(repeat('00',32),'hex')
    where id='82000000-0000-4000-8000-000000000003';
  raise exception 'issued version mutated';exception when others then
    if position('immutable employment authority version' in sqlerrm)=0 then raise;end if;
  end;end$$;

-- Prepare legitimate source A, then attempt to issue unrelated canonical B with a valid hash(B).
select '{"document_header":{"title":"legitimate source A"}}' attack_source_payload \gset
select encode(extensions.digest(convert_to(:'attack_source_payload','UTF8'),'sha256'),'hex') attack_source_digest \gset
set local role service_role;
select public.employment_authority_prepare_version('82000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000099','82000000-0000-4000-8000-000000000004',
  :'source_updated_at','signdee.employment.document.v1',:'attack_source_payload',:'attack_source_digest');
reset role;

do $$declare accepted boolean:=false;d jsonb:=jsonb_build_object(
  'canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id','82000000-0000-4000-8000-000000000002','legacy_contract_id','82000000-0000-4000-8000-000000000001',
    'version_id','82000000-0000-4000-8000-000000000004','version_number',2),
  'document_header',jsonb_build_object('title','unrelated synthetic B'));h text;source_updated_at timestamptz;
begin
  h:=encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex');select updated_at into source_updated_at from public.emp_contracts where id='82000000-0000-4000-8000-000000000001';
  begin execute 'set local role service_role';perform public.employment_authority_issue_version(
    '82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000004',
    source_updated_at,'signdee.employment.document.v1',d::text,d,h);accepted:=true;
  exception when others then
    if position('employment_version_canonical_mismatch' in sqlerrm)=0 then raise;end if;
  end;reset role;
  if accepted then raise exception 'unrelated canonical payload accepted';end if;
  if (select lifecycle_status from public.employment_authority_versions
    where id='82000000-0000-4000-8000-000000000004')<>'draft' then raise exception 'failed issue changed lifecycle';end if;
end$$;

-- An unsupported future schema cannot reuse v1 identity.
do $$declare accepted boolean:=false;begin
  begin execute 'set local role service_role';perform public.employment_authority_prepare_version(
    '82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000099',
    '82000000-0000-4000-8000-000000000005','2026-08-06T01:00:00Z','signdee.employment.document.v2',
    '{"document_header":{"title":"legitimate A"}}',
    encode(extensions.digest(convert_to('{"document_header":{"title":"legitimate A"}}','UTF8'),'sha256'),'hex'));
    accepted:=true;exception when others then null;end;reset role;
  if accepted then raise exception 'unsupported schema reused v1 authority';end if;
end$$;

-- A material source mutation after prepare still prevents issuance.
update public.emp_contracts set position_th='วิศวกรอาวุโส',updated_at='2026-08-06T02:00:00Z'
where id='82000000-0000-4000-8000-000000000001';
do $$declare accepted boolean:=false;d jsonb:='{}';h text;begin
  h:=encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex');
  begin execute 'set local role service_role';perform public.employment_authority_issue_version(
    '82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000004',
    '2026-08-06T01:00:00Z','signdee.employment.document.v1',d::text,d,h);accepted:=true;
  exception when others then
    if position('employment_version_source_stale' in sqlerrm)=0 then raise;end if;
  end;reset role;
  if accepted then raise exception 'stale source issued';end if;
end$$;

do $$declare denied boolean:=false;begin
  begin execute 'set local role anon';perform count(*) from public.employment_authority_versions;
  exception when insufficient_privilege then denied:=true;end;reset role;
  if not denied then raise exception 'anon read authority';end if;
end$$;
do $$declare denied boolean:=false;begin
  begin execute 'set local role authenticated';perform public.employment_authority_prepare_version(
    '82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000099',
    '82000000-0000-4000-8000-000000000006','2026-08-06T02:00:00Z','signdee.employment.document.v1','{}',
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  exception when insufficient_privilege then denied:=true;end;reset role;
  if not denied then raise exception 'authenticated executed authority';end if;
end$$;

rollback;
\echo 'SD-408A.1 Employment version database assertions passed'

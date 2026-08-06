\set ON_ERROR_STOP on
begin;

insert into public.emp_contracts(id,contract_no,status,position_th,employment_type,salary,
  work_days,party_a,party_b,jd,clauses,updated_at)
values('92000000-0000-4000-8000-000000000001','EMP-A2','generated','Engineer','full_time',1,
  '[]','{"name":"Employer"}','{"name":"Employee"}','{}','{}','2026-08-06T01:00:00Z');

insert into public.employment_authority_contracts(id,legacy_contract_id)
values('92000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000001');

do $$declare source jsonb;doc jsonb;begin
  source:=jsonb_build_object('document_header',jsonb_build_object('title','Employment'),
    'parties',jsonb_build_array(jsonb_build_object('role','employer','display_name','Employer'),
      jsonb_build_object('role','employee','display_name','Employee')));
  doc:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id','92000000-0000-4000-8000-000000000002','legacy_contract_id','92000000-0000-4000-8000-000000000001',
    'version_id','92000000-0000-4000-8000-000000000003','version_number',1))||source;
  insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
    source_updated_at,source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,
    canonical_document,document_hash,lifecycle_status,issued_at)
  values('92000000-0000-4000-8000-000000000003','92000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000001',1,'2026-08-06T01:00:00Z',
    extensions.digest(convert_to(source::text,'UTF8'),'sha256'),source::text,'signdee.employment.document.v1',
    doc::text,doc,extensions.digest(convert_to(doc::text,'UTF8'),'sha256'),'issued',clock_timestamp());
end$$;

set local role service_role;
select public.employment_authority_authorize_signers(
  '92000000-0000-4000-8000-000000000003',
  jsonb_build_array(
    jsonb_build_object('id','92000000-0000-4000-8000-000000000004','capability_id','92000000-0000-4000-8000-000000000005',
      'role','employer','capability_digest',repeat('aa',32),'expires_at',clock_timestamp()+interval '3 days'),
    jsonb_build_object('id','92000000-0000-4000-8000-000000000006','capability_id','92000000-0000-4000-8000-000000000007',
      'role','employee','capability_digest',repeat('bb',32),'expires_at',clock_timestamp()+interval '3 days')));
select public.employment_authority_sign_version(repeat('aa',32),repeat('11',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version(repeat('aa',32),repeat('11',32),'signdee.employment.signing-consent.v1');
reset role;

do $$begin
  if (select count(*) from public.employment_authority_signers where signing_status='signed')<>1
    then raise exception 'retry duplicated signer result';end if;
  if (select count(*) from public.employment_authority_signing_audit_events where event_type='signer.signed')<>1
    then raise exception 'retry duplicated signer audit';end if;
  if (select count(*) from public.employment_authority_signers where version_id='92000000-0000-4000-8000-000000000003')<>2
    then raise exception 'version signer mapping incomplete';end if;
end$$;

-- A capability cannot authorize another signer/version, and unauthoritative values fail closed.
do $$declare accepted boolean:=false;begin
  begin perform public.employment_authority_sign_version(repeat('cc',32),repeat('22',32),
    'signdee.employment.signing-consent.v1');accepted:=true;exception when others then null;end;
  if accepted then raise exception 'unknown signer capability accepted';end if;
end$$;

-- A forced audit failure rolls back signer and capability mutations.
create function pg_temp.fail_employee_audit() returns trigger language plpgsql as $$begin
  if new.signer_id='92000000-0000-4000-8000-000000000006' then raise exception 'forced audit failure';end if;
  return new;end$$;
create trigger employment_a2_forced_failure before insert on public.employment_authority_signing_audit_events
for each row execute function pg_temp.fail_employee_audit();
do $$declare accepted boolean:=false;begin
  begin execute 'set local role service_role';perform public.employment_authority_sign_version(
    repeat('bb',32),repeat('22',32),'signdee.employment.signing-consent.v1');accepted:=true;
  exception when others then if position('forced audit failure' in sqlerrm)=0 then raise;end if;end;reset role;
  if accepted then raise exception 'forced failure accepted';end if;
  if (select signing_status from public.employment_authority_signers
      where id='92000000-0000-4000-8000-000000000006')<>'pending'
    or (select consumed_at from public.employment_authority_signing_capabilities
      where signer_id='92000000-0000-4000-8000-000000000006') is not null
    then raise exception 'failed transaction left partial signing state';end if;
end$$;
drop trigger employment_a2_forced_failure on public.employment_authority_signing_audit_events;

-- Both independent version-bound signers are retained.
set local role service_role;
select public.employment_authority_sign_version(repeat('bb',32),repeat('22',32),'signdee.employment.signing-consent.v1');
reset role;
do $$begin if (select count(*) from public.employment_authority_signers where signing_status='signed')<>2
  then raise exception 'two signer results lost';end if;end$$;

do $$declare denied boolean:=false;begin
  begin execute 'set local role anon';perform count(*) from public.employment_authority_signers;
  exception when insufficient_privilege then denied:=true;end;reset role;
  if not denied then raise exception 'anon read signer authority';end if;
end$$;
do $$declare denied boolean:=false;begin
  begin execute 'set local role authenticated';perform count(*) from public.employment_authority_signing_capabilities;
  exception when insufficient_privilege then denied:=true;end;reset role;
  if not denied then raise exception 'authenticated read capability authority';end if;
end$$;
do $$declare denied boolean:=false;begin
  begin execute 'set local role service_role';update public.employment_authority_signers set signing_status='pending';
  exception when insufficient_privilege then denied:=true;end;reset role;
  if not denied then raise exception 'service role directly mutated signer authority';end if;
end$$;

rollback;
\echo 'SD-408A.2 Employment signing database assertions passed'

\set ON_ERROR_STOP on
begin;

create function public.sd408a3_assert(ok boolean,message text) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message;end if;end$$;

create function public.sd408a3_create(emp uuid,legacy uuid,version uuid,employer uuid,employee uuid,
  employer_cap uuid,employee_cap uuid,employer_digest text,employee_digest text)
returns void language plpgsql as $$declare source jsonb;doc jsonb;begin
  insert into public.emp_contracts(id,updated_at) values(legacy,'2026-08-06T01:00:00Z');
  insert into public.employment_authority_contracts(id,legacy_contract_id) values(emp,legacy);
  source:=jsonb_build_object('parties',jsonb_build_array(
    jsonb_build_object('role','employer','name','Employer'),
    jsonb_build_object('role','employee','name','Employee')),'content','Employment evidence');
  doc:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id',emp,'legacy_contract_id',legacy,'version_id',version,'version_number',1))||source;
  insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
    source_updated_at,source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,
    canonical_document,document_hash,lifecycle_status,issued_at)
  values(version,emp,legacy,1,'2026-08-06T01:00:00Z',
    extensions.digest(convert_to(source::text,'UTF8'),'sha256'),source::text,
    'signdee.employment.document.v1',doc::text,doc,
    extensions.digest(convert_to(doc::text,'UTF8'),'sha256'),'issued',clock_timestamp());
  perform public.employment_authority_authorize_signers(version,jsonb_build_array(
    jsonb_build_object('id',employer,'capability_id',employer_cap,'role','employer',
      'capability_digest',employer_digest,'expires_at',clock_timestamp()+interval '3 days'),
    jsonb_build_object('id',employee,'capability_id',employee_cap,'role','employee',
      'capability_digest',employee_digest,'expires_at',clock_timestamp()+interval '3 days')));
end$$;

create function public.sd408a3_expect_failure(emp uuid,version uuid,label text)
returns void language plpgsql as $$declare failed boolean:=false;begin
  begin perform public.employment_authority_issue_signed_evidence(emp,version);
  exception when others then failed:=true;end;
  if not failed then raise exception 'expected evidence failure: %',label;end if;
end$$;

select public.sd408a3_assert((select relrowsecurity from pg_class
  where oid='public.employment_signed_evidence_authorities'::regclass),'evidence RLS enabled');
select public.sd408a3_assert(
  has_function_privilege('service_role','public.employment_authority_issue_signed_evidence(uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.employment_authority_resolve_signed_evidence(text)','EXECUTE')
  and not has_function_privilege('anon','public.employment_authority_issue_signed_evidence(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.employment_authority_issue_signed_evidence(uuid,uuid)','EXECUTE'),
  'only service role executes evidence RPCs');

do $$declare denied boolean:=false;begin
  begin execute 'set local role anon';perform count(*) from public.employment_signed_evidence_authorities;
  exception when insufficient_privilege then denied:=true;end;reset role;
  perform public.sd408a3_assert(denied,'anon direct read denied');end$$;
do $$declare denied boolean:=false;begin
  begin execute 'set local role authenticated';perform count(*) from public.employment_signed_evidence_authorities;
  exception when insufficient_privilege then denied:=true;end;reset role;
  perform public.sd408a3_assert(denied,'authenticated direct read denied');end$$;
do $$declare denied boolean:=false;begin
  begin execute 'set local role service_role';delete from public.employment_signed_evidence_authorities;
  exception when insufficient_privilege then denied:=true;end;reset role;
  perform public.sd408a3_assert(denied,'service role direct mutation denied');end$$;

-- Unsigned, partial, wrong aggregate/version, and draft versions fail closed.
select public.sd408a3_create('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000004',
  'a1000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000006',
  'a1000000-0000-4000-8000-000000000007',repeat('11',32),repeat('12',32));
set local role service_role;
select public.sd408a3_expect_failure('a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000003','unsigned');
select public.employment_authority_sign_version(repeat('11',32),repeat('21',32),
  'signdee.employment.signing-consent.v1');
select public.sd408a3_expect_failure('a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000003','partial');
select public.sd408a3_expect_failure('a1000000-0000-4000-8000-000000000099',
  'a1000000-0000-4000-8000-000000000003','wrong employment');
reset role;

insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
  source_updated_at,source_content_digest,source_canonical_payload,canonical_schema)
select 'a1000000-0000-4000-8000-000000000008',employment_id,legacy_contract_id,2,source_updated_at,
  extensions.digest(convert_to('{"draft":true}','UTF8'),'sha256'),'{"draft":true}',canonical_schema
from public.employment_authority_versions where id='a1000000-0000-4000-8000-000000000003';
set local role service_role;
select public.sd408a3_expect_failure('a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000008','draft');
reset role;

-- Exact complete signer set issues once and resolves the same durable authority.
select public.sd408a3_create('a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002',
  'a2000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000004',
  'a2000000-0000-4000-8000-000000000005','a2000000-0000-4000-8000-000000000006',
  'a2000000-0000-4000-8000-000000000007',repeat('31',32),repeat('32',32));
set local role service_role;
select public.employment_authority_sign_version(repeat('31',32),repeat('41',32),
  'signdee.employment.signing-consent.v1');
select pg_sleep(0.01);
select public.employment_authority_sign_version(repeat('32',32),repeat('42',32),
  'signdee.employment.signing-consent.v1');
create temporary table sd408a3_results as select public.employment_authority_issue_signed_evidence(
  'a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000003') r;
insert into sd408a3_results select public.employment_authority_issue_signed_evidence(
  'a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000003');
reset role;

select public.sd408a3_assert((select count(*)=1 from public.employment_signed_evidence_authorities
  where employment_id='a2000000-0000-4000-8000-000000000001'),'one evidence artifact');
select public.sd408a3_assert((select count(distinct r->>'signed_document_reference')=1 from sd408a3_results),
  'stable evidence reference');
select public.sd408a3_assert((select count(*)=1 from sd408a3_results where r->>'created'='false'),
  'one idempotent replay');
select public.sd408a3_assert((select source_completed_at=(select max(signed_at)
    from public.employment_authority_signers where employment_id=e.employment_id and version_id=e.version_id and is_required)
    and issued_at>=source_completed_at
  from public.employment_signed_evidence_authorities e
  where employment_id='a2000000-0000-4000-8000-000000000001'),'completion and issuance timestamps distinct');
select public.sd408a3_assert((select signer_evidence_manifest->0->>'signer_role'='employee'
    and signer_evidence_manifest->1->>'signer_role'='employer'
    and signer_evidence_set_digest=extensions.digest(convert_to(signer_evidence_manifest::text,'UTF8'),'sha256')
    and signed_document_reference~'^sde_emp_[0-9a-f]{64}$'
  from public.employment_signed_evidence_authorities
  where employment_id='a2000000-0000-4000-8000-000000000001'),'manifest deterministic and digest-bound');

select signed_document_reference evidence_reference from public.employment_signed_evidence_authorities
  where employment_id='a2000000-0000-4000-8000-000000000001' \gset
set local role service_role;
select public.sd408a3_assert((public.employment_authority_resolve_signed_evidence(:'evidence_reference')
  ->>'signer_evidence_set_digest') like 'sha256:%','opaque reference resolves');
reset role;

do $$declare failed boolean:=false;begin
  begin update public.employment_signed_evidence_authorities set version_number=2
    where employment_id='a2000000-0000-4000-8000-000000000001';
  exception when others then failed:=true;end;
  perform public.sd408a3_assert(failed,'evidence update rejected');end$$;
do $$declare failed boolean:=false;begin
  begin delete from public.employment_signed_evidence_authorities
    where employment_id='a2000000-0000-4000-8000-000000000001';
  exception when others then failed:=true;end;
  perform public.sd408a3_assert(failed,'evidence delete rejected');end$$;

-- A later issued version does not invalidate or replace historical completed evidence.
do $$declare source jsonb;doc jsonb;begin
  source:='{"content":"later"}';
  doc:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id','a2000000-0000-4000-8000-000000000001',
    'legacy_contract_id','a2000000-0000-4000-8000-000000000002',
    'version_id','a2000000-0000-4000-8000-000000000008','version_number',2))||source;
  insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
    source_updated_at,source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,
    canonical_document,document_hash,lifecycle_status,issued_at)
  values('a2000000-0000-4000-8000-000000000008','a2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000002',2,'2026-08-06T01:00:00Z',
    extensions.digest(convert_to(source::text,'UTF8'),'sha256'),source::text,
    'signdee.employment.document.v1',doc::text,doc,
    extensions.digest(convert_to(doc::text,'UTF8'),'sha256'),'issued',clock_timestamp());end$$;
set local role service_role;
select public.sd408a3_assert((public.employment_authority_resolve_signed_evidence(:'evidence_reference')
  ->>'version_id')='a2000000-0000-4000-8000-000000000003','historical evidence remains exact');
reset role;

-- Corrupt signer action binding and missing consent/signature facts fail closed.
select public.sd408a3_create('a3000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000002',
  'a3000000-0000-4000-8000-000000000003','a3000000-0000-4000-8000-000000000004',
  'a3000000-0000-4000-8000-000000000005','a3000000-0000-4000-8000-000000000006',
  'a3000000-0000-4000-8000-000000000007',repeat('51',32),repeat('52',32));
set local role service_role;
select public.employment_authority_sign_version(repeat('51',32),repeat('61',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version(repeat('52',32),repeat('62',32),'signdee.employment.signing-consent.v1');
reset role;
alter table public.employment_authority_signers disable trigger employment_authority_signer_guard;
update public.employment_authority_signers set signing_action_digest=decode(repeat('00',32),'hex')
  where id='a3000000-0000-4000-8000-000000000004';
alter table public.employment_authority_signers enable trigger employment_authority_signer_guard;
set local role service_role;
select public.sd408a3_expect_failure('a3000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000003','corrupt action digest');
reset role;

select public.sd408a3_create('a4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000003','a4000000-0000-4000-8000-000000000004',
  'a4000000-0000-4000-8000-000000000005','a4000000-0000-4000-8000-000000000006',
  'a4000000-0000-4000-8000-000000000007',repeat('71',32),repeat('72',32));
set local role service_role;
select public.employment_authority_sign_version(repeat('71',32),repeat('81',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version(repeat('72',32),repeat('82',32),'signdee.employment.signing-consent.v1');
reset role;
alter table public.employment_authority_signers disable trigger employment_authority_signer_guard;
do $$declare c text;begin select conname into c from pg_constraint
  where conrelid='public.employment_authority_signers'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%consent_schema%';
  execute format('alter table public.employment_authority_signers drop constraint %I',c);end$$;
update public.employment_authority_signers set consent_schema=null,signature_input_digest=null
  where id='a4000000-0000-4000-8000-000000000004';
alter table public.employment_authority_signers enable trigger employment_authority_signer_guard;
set local role service_role;
select public.sd408a3_expect_failure('a4000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000003','missing consent and signature digest');
reset role;

-- Canonical hash corruption fails closed even if privileged constraints are bypassed.
select public.sd408a3_create('a5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000002',
  'a5000000-0000-4000-8000-000000000003','a5000000-0000-4000-8000-000000000004',
  'a5000000-0000-4000-8000-000000000005','a5000000-0000-4000-8000-000000000006',
  'a5000000-0000-4000-8000-000000000007',repeat('91',32),repeat('92',32));
set local role service_role;
select public.employment_authority_sign_version(repeat('91',32),repeat('a1',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version(repeat('92',32),repeat('a2',32),'signdee.employment.signing-consent.v1');
reset role;
alter table public.employment_authority_versions disable trigger employment_authority_version_guard;
do $$declare c text;begin select conname into c from pg_constraint
  where conrelid='public.employment_authority_versions'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%digest%canonical_payload%document_hash%';
  execute format('alter table public.employment_authority_versions drop constraint %I',c);end$$;
update public.employment_authority_versions set canonical_payload=canonical_payload||' '
  where id='a5000000-0000-4000-8000-000000000003';
alter table public.employment_authority_versions enable trigger employment_authority_version_guard;
set local role service_role;
select public.sd408a3_expect_failure('a5000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000003','canonical mismatch');
reset role;

drop function public.sd408a3_expect_failure(uuid,uuid,text);
drop function public.sd408a3_create(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text);
drop function public.sd408a3_assert(boolean,text);
rollback;
\echo 'SD-408A.3 Employment signed-evidence database assertions passed'

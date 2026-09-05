\set ON_ERROR_STOP on
begin;

create function public.sd407c_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$ begin
  if not coalesce(p_condition,false) then raise exception 'assertion failed: %',p_message; end if;
end $$;

create function public.sd407c_document(p_nda uuid,p_version uuid,p_a uuid,p_b uuid)
returns jsonb language sql immutable as $$ select jsonb_build_object(
  'canonical_schema','signdee.nda.document.v1','nda_id',p_nda::text,
  'version_id',p_version::text,'version_number',1,
  'parties',jsonb_build_array(
    jsonb_build_object('signer_id',p_a::text,'party_ref',(p_a::text)::uuid,'role','discloser'),
    jsonb_build_object('signer_id',p_b::text,'party_ref',(p_b::text)::uuid,'role','recipient')),
  'title','Signed evidence runtime test','clauses',jsonb_build_array('one','two')) $$;

create function public.sd407c_create(p_nda uuid,p_version uuid,p_a uuid,p_b uuid,p_da text,p_db text)
returns void language plpgsql as $$ declare d jsonb; begin
  d:=public.sd407c_document(p_nda,p_version,p_a,p_b);
  perform public.nda_authority_create_initial_version(
    p_nda,p_version,'signdee.nda.document.v1',d::text,d,
    encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex'),
    jsonb_build_array(
      jsonb_build_object('id',p_a,'party_ref',p_a,'role','discloser','capability_digest',p_da,'expires_at','2099-01-01Z'),
      jsonb_build_object('id',p_b,'party_ref',p_b,'role','recipient','capability_digest',p_db,'expires_at','2099-01-01Z')));
end $$;

create function public.sd407c_complete(p_nda uuid,p_version uuid,p_a uuid,p_b uuid,p_da text,p_db text)
returns void language plpgsql as $$ begin
  perform public.nda_authority_sign_version(p_nda,p_version,p_a,p_da,'signdee.nda.signing-consent.v1');
  perform public.nda_authority_sign_version(p_nda,p_version,p_b,p_db,'signdee.nda.signing-consent.v1');
end $$;

create function public.sd407c_expect_failure(p_nda uuid,p_version uuid,p_label text)
returns void language plpgsql as $$ declare failed boolean:=false; begin
  begin perform public.nda_authority_issue_signed_evidence(p_nda,p_version);
  exception when others then failed:=true; end;
  if not failed then raise exception 'expected issuance failure: %',p_label; end if;
end $$;

select public.sd407c_assert(
  (select bool_and(relrowsecurity) from pg_class where oid in
    ('public.nda_signed_evidence_authorities'::regclass,'public.nda_signed_evidence_audit_events'::regclass)),
  'signed evidence RLS enabled');
select public.sd407c_assert(
  has_function_privilege('service_role','public.nda_authority_issue_signed_evidence(uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.nda_authority_resolve_signed_evidence(text)','EXECUTE')
  and not has_function_privilege('anon','public.nda_authority_issue_signed_evidence(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.nda_authority_issue_signed_evidence(uuid,uuid)','EXECUTE'),
  'only service role executes evidence boundary');

do $$ declare denied boolean:=false; begin
  begin execute 'set local role anon'; perform count(*) from public.nda_signed_evidence_authorities;
  exception when insufficient_privilege then denied:=true; end;
  execute 'reset role'; perform public.sd407c_assert(denied,'anon read denied');
end $$;
do $$ declare denied boolean:=false; begin
  begin execute 'set local role service_role'; delete from public.nda_signed_evidence_authorities;
  exception when insufficient_privilege then denied:=true; end;
  execute 'reset role'; perform public.sd407c_assert(denied,'service direct mutation denied');
end $$;

-- Unsigned and partially signed aggregates fail closed.
set local role service_role;
select public.sd407c_create('81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000003','81000000-0000-4000-8000-000000000004',repeat('11',32),repeat('12',32));
select public.sd407c_expect_failure('81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000002','unsigned');
select public.nda_authority_sign_version('81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000003',repeat('11',32),'signdee.nda.signing-consent.v1');
select public.sd407c_expect_failure('81000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000002','partial');
select public.sd407c_expect_failure('81000000-0000-4000-8000-000000000099','81000000-0000-4000-8000-000000000002','wrong NDA');
reset role;

-- Exact completed version issues once and resolves durably.
set local role service_role;
select public.sd407c_create('82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000004',repeat('21',32),repeat('22',32));
select public.sd407c_complete('82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000004',repeat('21',32),repeat('22',32));
create temporary table sd407c_results as
select public.nda_authority_issue_signed_evidence(
  '82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002') r;
insert into sd407c_results select public.nda_authority_issue_signed_evidence(
  '82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002');
reset role;

select public.sd407c_assert((select count(*)=1 from public.nda_signed_evidence_authorities
  where nda_id='82000000-0000-4000-8000-000000000001'),'one durable authority');
select public.sd407c_assert((select count(distinct r->>'signed_document_reference')=1 from sd407c_results),
  'duplicate returns stable reference');
select public.sd407c_assert((select count(*)=1 from sd407c_results
  where r->>'created'='false'),'replay represented');
select public.sd407c_assert((select e.source_completed_at=c.completed_at and e.source_completed_at=v.completed_at
  from public.nda_signed_evidence_authorities e join public.nda_authority_contracts c on c.id=e.nda_id
  join public.nda_authority_versions v on (v.nda_id,v.id)=(e.nda_id,e.version_id)
  where e.nda_id='82000000-0000-4000-8000-000000000001'),'completion timestamp authoritative');
select public.sd407c_assert((select jsonb_array_length(signer_evidence_manifest)=2
  and signer_evidence_set_digest=extensions.digest(convert_to(signer_evidence_manifest::text,'UTF8'),'sha256')
  and signed_document_reference !~ '^nda-authority:'
  from public.nda_signed_evidence_authorities where nda_id='82000000-0000-4000-8000-000000000001'),
  'manifest complete, hashed, and reference distinct');
select public.sd407c_assert((select count(*)=1 from public.nda_signed_evidence_audit_events
  where nda_id='82000000-0000-4000-8000-000000000001'),'issuance audited once');

select signed_document_reference as evidence_reference
from public.nda_signed_evidence_authorities
where nda_id='82000000-0000-4000-8000-000000000001' \gset
set local role service_role;
select public.sd407c_assert((public.nda_authority_resolve_signed_evidence(
  :'evidence_reference')->>'signer_evidence_set_digest') like 'sha256:%',
  'reference resolves minimized verification representation');
reset role;

do $$ declare failed boolean:=false; begin
  begin update public.nda_signed_evidence_authorities set version_number=2
    where nda_id='82000000-0000-4000-8000-000000000001';
  exception when others then failed:=true; end;
  perform public.sd407c_assert(failed,'authority immutable');
end $$;

-- Corrupted signer evidence and canonical hashes fail even with completed lifecycle claims.
set local role service_role;
select public.sd407c_create('83000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002',
  '83000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000004',repeat('31',32),repeat('32',32));
select public.sd407c_complete('83000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002',
  '83000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000004',repeat('31',32),repeat('32',32));
reset role;
alter table public.nda_authority_signers disable trigger nda_authority_signer_immutable;
update public.nda_authority_signers set signing_evidence_digest=decode(repeat('00',32),'hex')
where id='83000000-0000-4000-8000-000000000003';
alter table public.nda_authority_signers enable trigger nda_authority_signer_immutable;
set local role service_role;
select public.sd407c_expect_failure('83000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','invalid signer evidence');
reset role;

-- Missing consent fails closed even if privileged corruption bypasses normal guards.
set local role service_role;
select public.sd407c_create('84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000003','84000000-0000-4000-8000-000000000004',repeat('41',32),repeat('42',32));
select public.sd407c_complete('84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000003','84000000-0000-4000-8000-000000000004',repeat('41',32),repeat('42',32));
reset role;
alter table public.nda_authority_signers disable trigger nda_authority_signer_immutable;
alter table public.nda_authority_signers drop constraint nda_authority_signers_evidence_check;
update public.nda_authority_signers set consent_schema=null
where id='84000000-0000-4000-8000-000000000003';
alter table public.nda_authority_signers enable trigger nda_authority_signer_immutable;
set local role service_role;
select public.sd407c_expect_failure('84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000002','missing consent');
reset role;

-- Hash mismatch fails closed even if a DB owner bypasses normal immutability/checks.
set local role service_role;
select public.sd407c_create('85000000-0000-4000-8000-000000000001','85000000-0000-4000-8000-000000000002',
  '85000000-0000-4000-8000-000000000003','85000000-0000-4000-8000-000000000004',repeat('51',32),repeat('52',32));
select public.sd407c_complete('85000000-0000-4000-8000-000000000001','85000000-0000-4000-8000-000000000002',
  '85000000-0000-4000-8000-000000000003','85000000-0000-4000-8000-000000000004',repeat('51',32),repeat('52',32));
reset role;
alter table public.nda_authority_versions disable trigger nda_authority_version_immutable;
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid='public.nda_authority_versions'::regclass
    and contype='c' and pg_get_constraintdef(oid) like '%digest%canonical_payload%';
  execute format('alter table public.nda_authority_versions drop constraint %I',c);
end $$;
update public.nda_authority_versions
set canonical_document=canonical_document||'{"tampered":true}'::jsonb,
    canonical_payload=(canonical_document||'{"tampered":true}'::jsonb)::text
where id='85000000-0000-4000-8000-000000000002';
alter table public.nda_authority_versions enable trigger nda_authority_version_immutable;
set local role service_role;
select public.sd407c_expect_failure('85000000-0000-4000-8000-000000000001','85000000-0000-4000-8000-000000000002','canonical hash mismatch');
reset role;

rollback;

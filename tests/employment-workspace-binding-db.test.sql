\set ON_ERROR_STOP on
begin;

create function public.sd408a4_assert(ok boolean,message text) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'assertion failed: %',message;end if;end$$;
create function public.sd408a4_expect_failure(sql_text text,label text) returns void language plpgsql as $$
declare failed boolean:=false;begin begin execute sql_text;exception when others then failed:=true;end;
if not failed then raise exception 'expected failure: %',label;end if;end$$;

create function public.sd408a4_create(emp uuid,legacy uuid,version uuid,cap_a text,cap_b text,
  with_evidence boolean default true) returns void language plpgsql as $$
declare source jsonb;doc jsonb;begin
  insert into public.emp_contracts(id,updated_at) values(legacy,'2026-08-06T01:00:00Z');
  insert into public.employment_authority_contracts(id,legacy_contract_id) values(emp,legacy);
  source:=jsonb_build_object('parties',jsonb_build_array(jsonb_build_object('role','employer','name','A'),
    jsonb_build_object('role','employee','name','B')),'content','A.4 binding');
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
    jsonb_build_object('id',gen_random_uuid(),'capability_id',gen_random_uuid(),'role','employer',
      'capability_digest',cap_a,'expires_at',clock_timestamp()+interval '3 days'),
    jsonb_build_object('id',gen_random_uuid(),'capability_id',gen_random_uuid(),'role','employee',
      'capability_digest',cap_b,'expires_at',clock_timestamp()+interval '3 days')));
  perform public.employment_authority_sign_version(cap_a,repeat('11',32),
    'signdee.employment.signing-consent.v1');
  perform public.employment_authority_sign_version(cap_b,repeat('12',32),
    'signdee.employment.signing-consent.v1');
  if with_evidence then perform public.employment_authority_issue_signed_evidence(emp,version);end if;
end$$;

select public.sd408a4_assert((select bool_and(relrowsecurity) from pg_class where oid in
  ('public.employment_workspace_binding_authorities'::regclass,
   'public.employment_workspace_binding_audit_events'::regclass)),'binding RLS enabled');
select public.sd408a4_assert(
  has_function_privilege('service_role','public.employment_authority_reserve_workspace_binding(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('anon','public.employment_authority_reserve_workspace_binding(uuid,uuid,uuid,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.employment_authority_reserve_workspace_binding(uuid,uuid,uuid,text)','EXECUTE'),
  'only service role reserves');
do $$declare denied boolean:=false;begin begin execute 'set local role service_role';
  delete from public.employment_workspace_binding_authorities;exception when insufficient_privilege then denied:=true;end;
  reset role;perform public.sd408a4_assert(denied,'service direct mutation denied');end$$;

-- Fully signed but missing A.3 evidence cannot reserve; wrong aggregate/version also fails.
select public.sd408a4_create('a4100000-0000-4000-8000-000000000001','a4100000-0000-4000-8000-000000000002',
  'a4100000-0000-4000-8000-000000000003',repeat('11',32),repeat('12',32),false);
set local role service_role;
select public.sd408a4_expect_failure($q$select public.employment_authority_reserve_workspace_binding(
  'a4100000-0000-4000-8000-000000000001','a4100000-0000-4000-8000-000000000003',
  'a4100000-0000-4000-8000-000000000009','workspace-adapter:v1')$q$,'missing evidence');
select public.sd408a4_expect_failure($q$select public.employment_authority_reserve_workspace_binding(
  'a4100000-0000-4000-8000-000000000099','a4100000-0000-4000-8000-000000000003',
  'a4100000-0000-4000-8000-000000000009','workspace-adapter:v1')$q$,'wrong employment');
reset role;

-- Exact A.1/A.3 authority reserves once, replays, and conflicts for another Workspace.
select public.sd408a4_create('a4200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000002',
  'a4200000-0000-4000-8000-000000000003',repeat('21',32),repeat('22',32),true);
set local role service_role;
create temporary table sd408a4_reservations as select public.employment_authority_reserve_workspace_binding(
  'a4200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000003',
  'a4200000-0000-4000-8000-000000000009','workspace-adapter:v1') r;
insert into sd408a4_reservations select public.employment_authority_reserve_workspace_binding(
  'a4200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000003',
  'a4200000-0000-4000-8000-000000000009','workspace-adapter:v1');
insert into sd408a4_reservations select public.employment_authority_reserve_workspace_binding(
  'a4200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000003',
  'a4200000-0000-4000-8000-000000000010','workspace-adapter:v1');
reset role;
select public.sd408a4_assert((select count(*)=1 from public.employment_workspace_binding_authorities
  where employment_id='a4200000-0000-4000-8000-000000000001'),'one binding');
select public.sd408a4_assert((select count(*)=1 from sd408a4_reservations where r->>'created'='true')
  and (select count(*)=1 from sd408a4_reservations where r->>'created'='false')
  and (select count(*)=1 from sd408a4_reservations where r->>'outcome'='conflict'),'reserve outcomes');
select public.sd408a4_assert((select (b.employment_id,b.version_id,b.document_hash,b.signed_document_reference)
  is not distinct from (e.employment_id,e.version_id,e.document_hash,e.signed_document_reference)
  from public.employment_workspace_binding_authorities b join public.employment_signed_evidence_authorities e
    on e.employment_id=b.employment_id and e.version_id=b.version_id
  where b.employment_id='a4200000-0000-4000-8000-000000000001'),'exact evidence tuple');

select id binding_id,signed_document_reference evidence_ref from public.employment_workspace_binding_authorities
  where employment_id='a4200000-0000-4000-8000-000000000001' \gset
set local role service_role;
select public.sd408a4_expect_failure(format('select public.employment_authority_resolve_workspace_acceptance(%L,%L)',
  :'binding_id','sde_emp_'||repeat('0',64)),'wrong signed evidence');
select public.sd408a4_assert((public.employment_authority_resolve_workspace_acceptance(
  :'binding_id',:'evidence_ref')->>'employment_id')='a4200000-0000-4000-8000-000000000001','resolve exact');
create temporary table sd408a4_confirmations as select public.employment_authority_confirm_workspace_acceptance(
  :'binding_id','a4200000-0000-4000-8000-000000000009','a4200000-0000-4000-8000-000000000011') r;
insert into sd408a4_confirmations select public.employment_authority_confirm_workspace_acceptance(
  :'binding_id','a4200000-0000-4000-8000-000000000009','a4200000-0000-4000-8000-000000000011');
select public.sd408a4_expect_failure(format('select public.employment_authority_confirm_workspace_acceptance(%L,%L,%L)',
  :'binding_id','a4200000-0000-4000-8000-000000000009','a4200000-0000-4000-8000-000000000012'),
  'conflicting acknowledgement');
reset role;
select public.sd408a4_assert((select count(*)=1 from sd408a4_confirmations where r->>'created'='true')
  and (select count(*)=1 from sd408a4_confirmations where r->>'created'='false')
  and (select binding_status='bound' and workspace_result_reference='a4200000-0000-4000-8000-000000000011'
    from public.employment_workspace_binding_authorities where id=:'binding_id'),'acknowledgement recovery');
do $$declare failed boolean:=false;begin begin update public.employment_workspace_binding_authorities
  set version_id=gen_random_uuid() where employment_id='a4200000-0000-4000-8000-000000000001';
  exception when others then failed:=true;end;
  perform public.sd408a4_assert(failed,'binding identity immutable');end$$;

-- A later completed version cannot replace the historical aggregate binding.
do $$declare source jsonb;doc jsonb;begin source:=jsonb_build_object('content','later','parties',
  jsonb_build_array(jsonb_build_object('role','employer','name','A'),
    jsonb_build_object('role','employee','name','B')));
  doc:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id','a4200000-0000-4000-8000-000000000001','legacy_contract_id','a4200000-0000-4000-8000-000000000002',
    'version_id','a4200000-0000-4000-8000-000000000004','version_number',2))||source;
  insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
    source_updated_at,source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,
    canonical_document,document_hash,lifecycle_status,issued_at)
  values('a4200000-0000-4000-8000-000000000004','a4200000-0000-4000-8000-000000000001',
    'a4200000-0000-4000-8000-000000000002',2,'2026-08-06T01:00:00Z',
    extensions.digest(convert_to(source::text,'UTF8'),'sha256'),source::text,
    'signdee.employment.document.v1',doc::text,doc,extensions.digest(convert_to(doc::text,'UTF8'),'sha256'),
    'issued',clock_timestamp());end$$;
set local role service_role;
select public.employment_authority_authorize_signers('a4200000-0000-4000-8000-000000000004',jsonb_build_array(
  jsonb_build_object('id',gen_random_uuid(),'capability_id',gen_random_uuid(),'role','employer','capability_digest',repeat('31',32),'expires_at',clock_timestamp()+interval '3 days'),
  jsonb_build_object('id',gen_random_uuid(),'capability_id',gen_random_uuid(),'role','employee','capability_digest',repeat('32',32),'expires_at',clock_timestamp()+interval '3 days')));
select public.employment_authority_sign_version(repeat('31',32),repeat('41',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version(repeat('32',32),repeat('42',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_issue_signed_evidence('a4200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000004');
select public.sd408a4_assert((public.employment_authority_reserve_workspace_binding(
  'a4200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000004',
  'a4200000-0000-4000-8000-000000000009','workspace-adapter:v1')->>'outcome')='conflict',
  'later version cannot replace binding');
reset role;

-- Privileged A.3 tuple corruption is rejected by reservation revalidation.
select public.sd408a4_create('a4300000-0000-4000-8000-000000000001','a4300000-0000-4000-8000-000000000002',
  'a4300000-0000-4000-8000-000000000003',repeat('51',32),repeat('52',32),true);
alter table public.employment_signed_evidence_authorities disable trigger employment_signed_evidence_immutable;
do $$declare c text;begin select conname into c from pg_constraint
  where conrelid='public.employment_signed_evidence_authorities'::regclass and contype='f'
    and confrelid='public.employment_authority_versions'::regclass;
  execute format('alter table public.employment_signed_evidence_authorities drop constraint %I',c);end$$;
update public.employment_signed_evidence_authorities set document_hash=decode(repeat('00',32),'hex')
  where employment_id='a4300000-0000-4000-8000-000000000001';
alter table public.employment_signed_evidence_authorities enable trigger employment_signed_evidence_immutable;
set local role service_role;
select public.sd408a4_expect_failure($q$select public.employment_authority_reserve_workspace_binding(
  'a4300000-0000-4000-8000-000000000001','a4300000-0000-4000-8000-000000000003',
  'a4300000-0000-4000-8000-000000000009','workspace-adapter:v1')$q$,'A.1/A.3 hash disagreement');
reset role;

drop function public.sd408a4_create(uuid,uuid,uuid,text,text,boolean);
drop function public.sd408a4_expect_failure(text,text);
drop function public.sd408a4_assert(boolean,text);
rollback;
\echo 'SD-408A.4 Employment Workspace binding database assertions passed'

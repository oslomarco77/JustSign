-- SD-408A.3 — immutable completed Employment signed-evidence authority.
-- Apply after employment_authority_version.sql and employment_authority_signing.sql.
-- This migration does not read legacy signing state or create delivery/Workspace artifacts.
begin;

alter table public.employment_authority_versions
  add constraint employment_authority_versions_evidence_fk_unique
  unique (employment_id,id,document_hash);

create table public.employment_signed_evidence_authorities (
  id uuid primary key default gen_random_uuid(),
  signed_document_reference text not null unique
    default ('sde_emp_'||encode(extensions.gen_random_bytes(32),'hex'))
    check (signed_document_reference~'^sde_emp_[0-9a-f]{64}$'),
  employment_id uuid not null,
  version_id uuid not null,
  version_number integer not null check (version_number>0),
  document_hash bytea not null check (octet_length(document_hash)=32),
  source_completed_at timestamptz not null,
  signer_evidence_schema text not null
    check (signer_evidence_schema='signdee.employment.completed-signer-evidence.v1'),
  signer_evidence_manifest jsonb not null
    check (jsonb_typeof(signer_evidence_manifest)='array'
      and jsonb_array_length(signer_evidence_manifest)=2),
  signer_evidence_set_digest bytea not null check (octet_length(signer_evidence_set_digest)=32),
  issued_at timestamptz not null default clock_timestamp(),
  unique (employment_id,version_id),
  foreign key (employment_id,version_id,document_hash)
    references public.employment_authority_versions(employment_id,id,document_hash) on delete restrict,
  check (signer_evidence_set_digest=extensions.digest(
    convert_to(signer_evidence_manifest::text,'UTF8'),'sha256'))
);

create function public.employment_signed_evidence_immutable()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'employment signed evidence authority is immutable'; end $$;
create trigger employment_signed_evidence_immutable before update or delete
on public.employment_signed_evidence_authorities for each row
execute function public.employment_signed_evidence_immutable();

alter table public.employment_signed_evidence_authorities enable row level security;
revoke all on public.employment_signed_evidence_authorities from anon,authenticated,service_role;

create function public.employment_authority_issue_signed_evidence(
  p_employment_id uuid,p_version_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare authority public.employment_authority_contracts%rowtype;
  v public.employment_authority_versions%rowtype;
  existing public.employment_signed_evidence_authorities%rowtype;
  evidence public.employment_signed_evidence_authorities%rowtype;
  manifest jsonb;required_count integer;valid_count integer;
  employer_count integer;employee_count integer;completed_at timestamptz;
begin
  if p_employment_id is null or p_version_id is null then
    raise exception 'employment_signed_evidence_not_eligible';end if;

  select * into authority from public.employment_authority_contracts
    where id=p_employment_id for update;
  select * into v from public.employment_authority_versions
    where employment_id=p_employment_id and id=p_version_id for update;
  if not found or authority.id is null or v.lifecycle_status<>'issued'
    or v.canonical_document<>v.canonical_payload::jsonb
    or extensions.digest(convert_to(v.canonical_payload,'UTF8'),'sha256')<>v.document_hash
    then raise exception 'employment_signed_evidence_not_eligible';end if;

  select * into existing from public.employment_signed_evidence_authorities
    where employment_id=p_employment_id and version_id=p_version_id;
  if found then
    return jsonb_build_object('created',false,
      'signed_document_reference',existing.signed_document_reference,
      'employment_id',existing.employment_id,'version_id',existing.version_id,
      'version_number',existing.version_number,
      'document_hash','sha256:'||encode(existing.document_hash,'hex'),
      'source_completed_at',existing.source_completed_at,
      'signer_evidence_schema',existing.signer_evidence_schema,
      'signer_evidence_set_digest','sha256:'||encode(existing.signer_evidence_set_digest,'hex'),
      'issued_at',existing.issued_at);
  end if;

  perform 1 from public.employment_authority_signers
    where employment_id=p_employment_id and version_id=p_version_id
    order by signer_role,id for update;

  select count(*) filter(where is_required),
    count(*) filter(where is_required and signer_role='employer'),
    count(*) filter(where is_required and signer_role='employee'),
    count(*) filter(where is_required and signing_status='signed' and signed_at is not null
      and consent_schema='signdee.employment.signing-consent.v1'
      and octet_length(signer_identity_digest)=32 and octet_length(signature_input_digest)=32
      and octet_length(signing_action_digest)=32
      and signing_action_digest=extensions.digest(convert_to(concat_ws(E'\n',
        'SIGNDEE-EMPLOYMENT-SIGNING-ACTION-V1',employment_id::text,version_id::text,id::text,
        encode(v.document_hash,'hex'),encode(signer_identity_digest,'hex'),consent_schema,
        encode(signature_input_digest,'hex'),
        to_char(signed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'UTF8'),'sha256')),
    max(signed_at) filter(where is_required)
  into required_count,employer_count,employee_count,valid_count,completed_at
  from public.employment_authority_signers
  where employment_id=p_employment_id and version_id=p_version_id;

  if required_count<>2 or employer_count<>1 or employee_count<>1
    or valid_count<>required_count or completed_at is null then
    raise exception 'employment_signed_evidence_not_eligible';end if;

  select jsonb_agg(jsonb_build_object(
    'signer_id',id,'signer_role',signer_role,
    'signer_identity_digest','sha256:'||encode(signer_identity_digest,'hex'),
    'signed_at',to_char(signed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'consent_schema',consent_schema,
    'signature_input_digest','sha256:'||encode(signature_input_digest,'hex'),
    'signing_action_digest','sha256:'||encode(signing_action_digest,'hex'))
    order by signer_role,id)
  into manifest from public.employment_authority_signers
  where employment_id=p_employment_id and version_id=p_version_id and is_required;

  insert into public.employment_signed_evidence_authorities(
    employment_id,version_id,version_number,document_hash,source_completed_at,
    signer_evidence_schema,signer_evidence_manifest,signer_evidence_set_digest
  ) values (p_employment_id,p_version_id,v.version_number,v.document_hash,completed_at,
    'signdee.employment.completed-signer-evidence.v1',manifest,
    extensions.digest(convert_to(manifest::text,'UTF8'),'sha256')) returning * into evidence;

  return jsonb_build_object('created',true,
    'signed_document_reference',evidence.signed_document_reference,
    'employment_id',evidence.employment_id,'version_id',evidence.version_id,
    'version_number',evidence.version_number,
    'document_hash','sha256:'||encode(evidence.document_hash,'hex'),
    'source_completed_at',evidence.source_completed_at,
    'signer_evidence_schema',evidence.signer_evidence_schema,
    'signer_evidence_set_digest','sha256:'||encode(evidence.signer_evidence_set_digest,'hex'),
    'issued_at',evidence.issued_at);
end $$;

create function public.employment_authority_resolve_signed_evidence(
  p_signed_document_reference text
) returns jsonb language plpgsql security definer stable set search_path=public,pg_temp as $$
declare evidence public.employment_signed_evidence_authorities%rowtype;
begin
  if p_signed_document_reference is null
    or p_signed_document_reference!~'^sde_emp_[0-9a-f]{64}$' then
    raise exception 'employment_signed_evidence_not_found';end if;
  select * into evidence from public.employment_signed_evidence_authorities
    where signed_document_reference=p_signed_document_reference;
  if not found then raise exception 'employment_signed_evidence_not_found';end if;
  return jsonb_build_object('signed_document_reference',evidence.signed_document_reference,
    'employment_id',evidence.employment_id,'version_id',evidence.version_id,
    'version_number',evidence.version_number,
    'document_hash','sha256:'||encode(evidence.document_hash,'hex'),
    'source_completed_at',evidence.source_completed_at,
    'signer_evidence_schema',evidence.signer_evidence_schema,
    'signer_evidence_set_digest','sha256:'||encode(evidence.signer_evidence_set_digest,'hex'),
    'issued_at',evidence.issued_at);
end $$;

revoke all on function public.employment_authority_issue_signed_evidence(uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.employment_authority_resolve_signed_evidence(text)
  from public,anon,authenticated;
grant execute on function public.employment_authority_issue_signed_evidence(uuid,uuid) to service_role;
grant execute on function public.employment_authority_resolve_signed_evidence(text) to service_role;
alter function public.employment_authority_issue_signed_evidence(uuid,uuid) owner to postgres;
alter function public.employment_authority_resolve_signed_evidence(text) owner to postgres;
revoke execute on function public.employment_signed_evidence_immutable() from public;

commit;

-- SD-407A.2C — durable completed NDA signed-evidence authority.
-- Apply after nda_authority_signing.sql. This migration never reads legacy
-- public.nda_contracts and does not create a PDF or Workspace integration.

begin;

create table public.nda_signed_evidence_authorities (
  id uuid primary key default gen_random_uuid(),
  signed_document_reference text not null unique
    default ('sde_' || encode(extensions.gen_random_bytes(32), 'hex'))
    check (signed_document_reference ~ '^sde_[0-9a-f]{64}$'),
  nda_id uuid not null,
  version_id uuid not null,
  version_number integer not null check (version_number > 0),
  document_hash bytea not null check (octet_length(document_hash) = 32),
  source_completed_at timestamptz not null,
  signer_evidence_schema text not null
    check (signer_evidence_schema = 'signdee.nda.completed-signer-evidence.v1'),
  signer_evidence_manifest jsonb not null
    check (jsonb_typeof(signer_evidence_manifest) = 'array'
      and jsonb_array_length(signer_evidence_manifest) > 0),
  signer_evidence_set_digest bytea not null
    check (octet_length(signer_evidence_set_digest) = 32),
  issued_at timestamptz not null default clock_timestamp(),
  unique (nda_id, version_id),
  foreign key (nda_id, version_id, document_hash)
    references public.nda_authority_versions(nda_id, id, document_hash) on delete restrict,
  check (signer_evidence_set_digest = extensions.digest(
    convert_to(signer_evidence_manifest::text, 'UTF8'), 'sha256'))
);

alter table public.nda_signed_evidence_authorities
  add constraint nda_signed_evidence_authority_identity_unique
    unique (id, nda_id, version_id);

create table public.nda_signed_evidence_audit_events (
  id bigint generated always as identity primary key,
  evidence_authority_id uuid not null,
  nda_id uuid not null,
  version_id uuid not null,
  event_type text not null check (event_type = 'signed_evidence.issued'),
  occurred_at timestamptz not null,
  foreign key (evidence_authority_id, nda_id, version_id)
    references public.nda_signed_evidence_authorities(id, nda_id, version_id)
      on delete restrict
);

create index nda_signed_evidence_reference_idx
  on public.nda_signed_evidence_authorities(signed_document_reference);
create index nda_signed_evidence_audit_authority_idx
  on public.nda_signed_evidence_audit_events(nda_id, version_id, occurred_at, id);

create function public.nda_signed_evidence_immutable()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'nda signed evidence authority is immutable';
end $$;

create trigger nda_signed_evidence_immutable
before update or delete on public.nda_signed_evidence_authorities
for each row execute function public.nda_signed_evidence_immutable();

create function public.nda_signed_evidence_audit_append_only()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'nda signed evidence audit is append-only';
end $$;

create trigger nda_signed_evidence_audit_append_only
before update or delete on public.nda_signed_evidence_audit_events
for each row execute function public.nda_signed_evidence_audit_append_only();

alter table public.nda_signed_evidence_authorities enable row level security;
alter table public.nda_signed_evidence_audit_events enable row level security;

revoke all on public.nda_signed_evidence_authorities
  from anon, authenticated, service_role;
revoke all on public.nda_signed_evidence_audit_events
  from anon, authenticated, service_role;
revoke all on sequence public.nda_signed_evidence_audit_events_id_seq
  from anon, authenticated, service_role;

create function public.nda_authority_issue_signed_evidence(
  p_nda_id uuid,
  p_version_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_contract public.nda_authority_contracts%rowtype;
  v_version public.nda_authority_versions%rowtype;
  v_existing public.nda_signed_evidence_authorities%rowtype;
  v_evidence public.nda_signed_evidence_authorities%rowtype;
  v_manifest jsonb;
  v_required_count integer;
  v_valid_count integer;
begin
  if p_nda_id is null or p_version_id is null then
    raise exception 'nda_signed_evidence_not_eligible';
  end if;

  select * into v_contract from public.nda_authority_contracts
  where id = p_nda_id for update;
  select * into v_version from public.nda_authority_versions
  where nda_id = p_nda_id and id = p_version_id for update;

  if not found or v_contract.id is null
     or v_contract.lifecycle_status <> 'completed'
     or v_contract.completed_version_id <> p_version_id
     or v_contract.completed_at is null
     or v_version.lifecycle_status <> 'completed'
     or v_version.completed_at is null
     or v_version.completed_at <> v_contract.completed_at
     or v_version.canonical_document <> v_version.canonical_payload::jsonb
     or extensions.digest(convert_to(v_version.canonical_payload, 'UTF8'), 'sha256')
       <> v_version.document_hash then
    raise exception 'nda_signed_evidence_not_eligible';
  end if;

  select * into v_existing from public.nda_signed_evidence_authorities
  where nda_id = p_nda_id and version_id = p_version_id;
  if found then
    return jsonb_build_object(
      'created', false,
      'signed_document_reference', v_existing.signed_document_reference,
      'nda_id', v_existing.nda_id,
      'version_id', v_existing.version_id,
      'version_number', v_existing.version_number,
      'document_hash', 'sha256:' || encode(v_existing.document_hash, 'hex'),
      'source_completed_at', v_existing.source_completed_at,
      'signer_evidence_schema', v_existing.signer_evidence_schema,
      'signer_evidence_set_digest', 'sha256:' || encode(v_existing.signer_evidence_set_digest, 'hex'),
      'issued_at', v_existing.issued_at
    );
  end if;

  -- Locks serialize the exact completed signer set against normal signer updates.
  perform 1 from public.nda_authority_signers
  where nda_id = p_nda_id and version_id = p_version_id
  order by signing_order, id for update;

  select count(*) filter (where is_required),
         count(*) filter (
           where is_required and signing_status = 'signed'
             and signed_at is not null and signed_at <= v_contract.completed_at
             and consent_schema = 'signdee.nda.signing-consent.v1'
             and octet_length(signing_evidence_digest) = 32
             and signing_evidence_digest = extensions.digest(convert_to(
               concat_ws(E'\n', 'SIGNDEE-NDA-SIGNING-EVIDENCE-V1', nda_id::text,
                 version_id::text, id::text, encode(v_version.document_hash, 'hex'),
                 consent_schema,
                 to_char(signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
               'UTF8'), 'sha256'))
  into v_required_count, v_valid_count
  from public.nda_authority_signers
  where nda_id = p_nda_id and version_id = p_version_id;

  if v_required_count < 1 or v_valid_count <> v_required_count then
    raise exception 'nda_signed_evidence_not_eligible';
  end if;

  select jsonb_agg(jsonb_build_object(
    'signer_id', id,
    'party_ref', party_ref,
    'signer_role', signer_role,
    'signing_order', signing_order,
    'signed_at', to_char(signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'consent_schema', consent_schema,
    'signing_evidence_digest', 'sha256:' || encode(signing_evidence_digest, 'hex')
  ) order by signing_order, id)
  into v_manifest
  from public.nda_authority_signers
  where nda_id = p_nda_id and version_id = p_version_id and is_required;

  insert into public.nda_signed_evidence_authorities(
    nda_id, version_id, version_number, document_hash, source_completed_at,
    signer_evidence_schema, signer_evidence_manifest, signer_evidence_set_digest
  ) values (
    p_nda_id, p_version_id, v_version.version_number, v_version.document_hash,
    v_contract.completed_at, 'signdee.nda.completed-signer-evidence.v1', v_manifest,
    extensions.digest(convert_to(v_manifest::text, 'UTF8'), 'sha256')
  ) returning * into v_evidence;

  insert into public.nda_signed_evidence_audit_events(
    evidence_authority_id, nda_id, version_id, event_type, occurred_at
  ) values (
    v_evidence.id, p_nda_id, p_version_id, 'signed_evidence.issued', v_evidence.issued_at
  );

  return jsonb_build_object(
    'created', true,
    'signed_document_reference', v_evidence.signed_document_reference,
    'nda_id', v_evidence.nda_id,
    'version_id', v_evidence.version_id,
    'version_number', v_evidence.version_number,
    'document_hash', 'sha256:' || encode(v_evidence.document_hash, 'hex'),
    'source_completed_at', v_evidence.source_completed_at,
    'signer_evidence_schema', v_evidence.signer_evidence_schema,
    'signer_evidence_set_digest', 'sha256:' || encode(v_evidence.signer_evidence_set_digest, 'hex'),
    'issued_at', v_evidence.issued_at
  );
end $$;

create function public.nda_authority_resolve_signed_evidence(
  p_signed_document_reference text
) returns jsonb
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare v_evidence public.nda_signed_evidence_authorities%rowtype;
begin
  if p_signed_document_reference is null
     or p_signed_document_reference !~ '^sde_[0-9a-f]{64}$' then
    raise exception 'nda_signed_evidence_not_found';
  end if;
  select * into v_evidence from public.nda_signed_evidence_authorities
  where signed_document_reference = p_signed_document_reference;
  if not found then raise exception 'nda_signed_evidence_not_found'; end if;
  return jsonb_build_object(
    'signed_document_reference', v_evidence.signed_document_reference,
    'nda_id', v_evidence.nda_id,
    'version_id', v_evidence.version_id,
    'version_number', v_evidence.version_number,
    'document_hash', 'sha256:' || encode(v_evidence.document_hash, 'hex'),
    'source_completed_at', v_evidence.source_completed_at,
    'signer_evidence_schema', v_evidence.signer_evidence_schema,
    'signer_evidence_set_digest', 'sha256:' || encode(v_evidence.signer_evidence_set_digest, 'hex'),
    'issued_at', v_evidence.issued_at
  );
end $$;

revoke all on function public.nda_authority_issue_signed_evidence(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.nda_authority_resolve_signed_evidence(text)
  from public, anon, authenticated;
grant execute on function public.nda_authority_issue_signed_evidence(uuid,uuid)
  to service_role;
grant execute on function public.nda_authority_resolve_signed_evidence(text)
  to service_role;
alter function public.nda_authority_issue_signed_evidence(uuid,uuid) owner to postgres;
alter function public.nda_authority_resolve_signed_evidence(text) owner to postgres;

revoke execute on function public.nda_signed_evidence_immutable() from public;
revoke execute on function public.nda_signed_evidence_audit_append_only() from public;

commit;

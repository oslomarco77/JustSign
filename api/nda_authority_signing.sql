-- SD-407A.2B — transactional signing for backend-authoritative NDA versions.
-- Apply after nda_authority_foundation.sql. This migration is additive and does
-- not read from or write to legacy public.nda_contracts.

begin;

alter table public.nda_authority_contracts
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists completed_version_id uuid,
  add column if not exists completed_at timestamptz;

alter table public.nda_authority_versions
  add column if not exists completed_at timestamptz;

alter table public.nda_authority_signers
  add column if not exists is_required boolean not null default true,
  add column if not exists signing_status text not null default 'pending',
  add column if not exists signed_at timestamptz,
  add column if not exists consent_schema text,
  add column if not exists signing_evidence_digest bytea;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.nda_authority_versions'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%lifecycle_status%'
  loop
    execute format('alter table public.nda_authority_versions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.nda_authority_versions
  add constraint nda_authority_versions_lifecycle_status_v2_check
    check (lifecycle_status in ('draft','issued','completed','void','superseded')),
  add constraint nda_authority_versions_lifecycle_fields_v2_check check (
    (lifecycle_status = 'draft' and issued_at is null and completed_at is null
      and invalidated_at is null and invalidation_reason is null and superseded_by_version_id is null)
    or (lifecycle_status = 'issued' and issued_at is not null and completed_at is null
      and invalidated_at is null and invalidation_reason is null and superseded_by_version_id is null)
    or (lifecycle_status = 'completed' and issued_at is not null and completed_at is not null
      and invalidated_at is null and invalidation_reason is null and superseded_by_version_id is null)
    or (lifecycle_status = 'void' and completed_at is null and invalidated_at is not null
      and invalidation_reason is not null and length(btrim(invalidation_reason)) > 0
      and superseded_by_version_id is null)
    or (lifecycle_status = 'superseded' and issued_at is not null and completed_at is null
      and invalidated_at is not null and invalidation_reason is not null
      and length(btrim(invalidation_reason)) > 0 and superseded_by_version_id is not null)
  );

alter table public.nda_authority_contracts
  add constraint nda_authority_contracts_lifecycle_check
    check (lifecycle_status in ('active','completed')),
  add constraint nda_authority_contracts_completion_check check (
    (lifecycle_status = 'active' and completed_version_id is null and completed_at is null)
    or (lifecycle_status = 'completed' and completed_version_id is not null and completed_at is not null)
  ),
  add constraint nda_authority_contracts_completed_version_fk
    foreign key (id, completed_version_id)
    references public.nda_authority_versions(nda_id, id) on delete restrict;

alter table public.nda_authority_signers
  add constraint nda_authority_signers_status_check
    check (signing_status in ('pending','signed')),
  add constraint nda_authority_signers_evidence_check check (
    (signing_status = 'pending' and signed_at is null and consent_schema is null and signing_evidence_digest is null)
    or (signing_status = 'signed' and signed_at is not null
      and consent_schema = 'signdee.nda.signing-consent.v1'
      and octet_length(signing_evidence_digest) = 32)
  );

create index if not exists nda_authority_required_signers_pending_idx
  on public.nda_authority_signers (nda_id, version_id, signing_status)
  where is_required;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.nda_authority_audit_events'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%event_type%'
  loop
    execute format('alter table public.nda_authority_audit_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.nda_authority_audit_events
  add constraint nda_authority_audit_event_type_v2_check check (event_type in (
    'authority.created','authority.completed','version.issued','version.completed',
    'capability.issued','capability.revoked','capability.consumed','signer.signed',
    'version.voided','version.superseded'
  ));

create or replace function public.nda_authority_guard_contract_update()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.authority_schema <> old.authority_schema
     or new.source_kind <> old.source_kind or new.created_at <> old.created_at then
    raise exception 'immutable nda authority contract identity';
  end if;
  if old.lifecycle_status = new.lifecycle_status then
    if new.completed_version_id is distinct from old.completed_version_id
       or new.completed_at is distinct from old.completed_at then
      raise exception 'immutable nda authority contract completion';
    end if;
    return new;
  end if;
  if old.lifecycle_status <> 'active' or new.lifecycle_status <> 'completed'
     or not exists (
       select 1 from public.nda_authority_versions
       where nda_id = new.id and id = new.completed_version_id
         and lifecycle_status = 'completed' and completed_at = new.completed_at
     ) then
    raise exception 'invalid nda authority contract transition';
  end if;
  return new;
end $$;

drop trigger if exists nda_authority_contract_immutable on public.nda_authority_contracts;
create trigger nda_authority_contract_immutable before update on public.nda_authority_contracts
for each row execute function public.nda_authority_guard_contract_update();

create or replace function public.nda_authority_guard_version_update()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.nda_id <> old.nda_id
     or new.version_number <> old.version_number
     or new.canonical_schema <> old.canonical_schema
     or new.canonical_payload <> old.canonical_payload
     or new.canonical_document <> old.canonical_document
     or new.document_hash <> old.document_hash
     or new.created_at <> old.created_at then
    raise exception 'immutable nda authority version';
  end if;
  if old.lifecycle_status = new.lifecycle_status then
    if new.issued_at is distinct from old.issued_at
       or new.completed_at is distinct from old.completed_at
       or new.invalidated_at is distinct from old.invalidated_at
       or new.invalidation_reason is distinct from old.invalidation_reason
       or new.superseded_by_version_id is distinct from old.superseded_by_version_id then
      raise exception 'immutable nda authority lifecycle evidence';
    end if;
    return new;
  end if;
  if old.lifecycle_status = 'draft' and new.lifecycle_status not in ('issued','void') then
    raise exception 'invalid nda authority lifecycle transition';
  elsif old.lifecycle_status = 'issued' and new.lifecycle_status not in ('completed','void','superseded') then
    raise exception 'invalid nda authority lifecycle transition';
  elsif old.lifecycle_status in ('completed','void','superseded') then
    raise exception 'terminal nda authority version is immutable';
  end if;
  if old.lifecycle_status = 'issued' and new.lifecycle_status in ('void','superseded') and exists (
    select 1 from public.nda_authority_capabilities
    where nda_id = old.nda_id and version_id = old.id and status = 'active'
  ) then
    raise exception 'active capabilities must be revoked before invalidation';
  end if;
  if new.lifecycle_status = 'completed' and (
    not exists (
      select 1 from public.nda_authority_signers
      where nda_id = old.nda_id and version_id = old.id and is_required
    ) or exists (
      select 1 from public.nda_authority_signers
      where nda_id = old.nda_id and version_id = old.id
        and is_required and signing_status <> 'signed'
    )
  ) then
    raise exception 'required signers have not completed this version';
  end if;
  return new;
end $$;

create or replace function public.nda_authority_audit_version_transition()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.lifecycle_status <> new.lifecycle_status and new.lifecycle_status in ('completed','void','superseded') then
    insert into public.nda_authority_audit_events
      (nda_id, version_id, event_type, event_data, occurred_at)
    values (
      new.nda_id, new.id,
      case new.lifecycle_status
        when 'completed' then 'version.completed'
        when 'superseded' then 'version.superseded'
        else 'version.voided'
      end,
      case when new.lifecycle_status = 'completed' then '{}'::jsonb else
        jsonb_build_object('reason', new.invalidation_reason,
          'superseded_by_version_id', new.superseded_by_version_id) end,
      coalesce(new.completed_at, new.invalidated_at, clock_timestamp())
    );
  end if;
  return new;
end $$;

create or replace function public.nda_authority_guard_signer_update()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.nda_id <> old.nda_id or new.version_id <> old.version_id
     or new.party_ref <> old.party_ref or new.signer_role <> old.signer_role
     or new.signing_order <> old.signing_order or new.is_required <> old.is_required
     or new.created_at <> old.created_at then
    raise exception 'immutable nda authority signer mapping';
  end if;
  if old.signing_status = new.signing_status then
    if new.signed_at is distinct from old.signed_at
       or new.consent_schema is distinct from old.consent_schema
       or new.signing_evidence_digest is distinct from old.signing_evidence_digest then
      raise exception 'immutable nda authority signing evidence';
    end if;
    return new;
  end if;
  if old.signing_status <> 'pending' or new.signing_status <> 'signed'
     or not exists (
       select 1 from public.nda_authority_versions
       where nda_id = new.nda_id and id = new.version_id and lifecycle_status = 'issued'
     ) then
    raise exception 'invalid nda authority signer transition';
  end if;
  return new;
end $$;

create or replace function public.nda_authority_sign_version(
  p_nda_id uuid,
  p_version_id uuid,
  p_signer_id uuid,
  p_capability_digest text,
  p_consent_schema text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_version public.nda_authority_versions%rowtype;
  v_signer public.nda_authority_signers%rowtype;
  v_capability public.nda_authority_capabilities%rowtype;
  v_accepted_at timestamptz;
  v_completed boolean := false;
  v_evidence_digest bytea;
begin
  if p_nda_id is null or p_version_id is null or p_signer_id is null
     or p_capability_digest is null or p_capability_digest !~ '^[0-9a-f]{64}$'
     or p_consent_schema <> 'signdee.nda.signing-consent.v1' then
    raise exception 'nda_signing_not_authorized';
  end if;

  select * into v_version from public.nda_authority_versions
  where nda_id = p_nda_id and id = p_version_id for update;
  if not found or v_version.lifecycle_status <> 'issued'
     or v_version.canonical_document <> v_version.canonical_payload::jsonb
     or extensions.digest(convert_to(v_version.canonical_payload, 'UTF8'), 'sha256') <> v_version.document_hash then
    raise exception 'nda_signing_not_authorized';
  end if;

  select * into v_signer from public.nda_authority_signers
  where nda_id = p_nda_id and version_id = p_version_id and id = p_signer_id for update;
  if not found then raise exception 'nda_signing_not_authorized'; end if;

  select * into v_capability from public.nda_authority_capabilities
  where nda_id = p_nda_id and version_id = p_version_id and signer_id = p_signer_id
    and capability_digest = decode(p_capability_digest, 'hex')
  for update;
  if not found then raise exception 'nda_signing_not_authorized'; end if;
  if v_capability.status = 'consumed' then raise exception 'nda_signing_conflict'; end if;
  if v_capability.status <> 'active' or v_capability.expires_at <= clock_timestamp() then
    raise exception 'nda_signing_not_authorized';
  end if;
  if v_signer.signing_status <> 'pending' then raise exception 'nda_signing_conflict'; end if;

  v_accepted_at := clock_timestamp();
  v_evidence_digest := extensions.digest(convert_to(
    concat_ws(E'\n', 'SIGNDEE-NDA-SIGNING-EVIDENCE-V1', p_nda_id::text,
      p_version_id::text, p_signer_id::text, encode(v_version.document_hash, 'hex'),
      p_consent_schema, to_char(v_accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'UTF8'), 'sha256');

  update public.nda_authority_signers
  set signing_status = 'signed', signed_at = v_accepted_at,
      consent_schema = p_consent_schema, signing_evidence_digest = v_evidence_digest
  where id = v_signer.id;

  update public.nda_authority_capabilities
  set status = 'consumed', consumed_at = v_accepted_at
  where id = v_capability.id and status = 'active';
  if not found then raise exception 'nda_signing_conflict'; end if;

  insert into public.nda_authority_audit_events
    (nda_id, version_id, signer_id, event_type, event_data, occurred_at)
  values
    (p_nda_id, p_version_id, p_signer_id, 'signer.signed',
      jsonb_build_object('consent_schema', p_consent_schema), v_accepted_at),
    (p_nda_id, p_version_id, p_signer_id, 'capability.consumed',
      '{}'::jsonb, v_accepted_at);

  if exists (
    select 1 from public.nda_authority_signers
    where nda_id = p_nda_id and version_id = p_version_id and is_required
  ) and not exists (
    select 1 from public.nda_authority_signers
    where nda_id = p_nda_id and version_id = p_version_id
      and is_required and signing_status <> 'signed'
  ) then
    update public.nda_authority_versions
    set lifecycle_status = 'completed', completed_at = v_accepted_at
    where nda_id = p_nda_id and id = p_version_id and lifecycle_status = 'issued';
    if not found then raise exception 'nda_signing_conflict'; end if;

    update public.nda_authority_contracts
    set lifecycle_status = 'completed', completed_version_id = p_version_id,
        completed_at = v_accepted_at
    where id = p_nda_id and lifecycle_status = 'active';
    if not found then raise exception 'nda_signing_conflict'; end if;

    insert into public.nda_authority_audit_events
      (nda_id, version_id, event_type, occurred_at)
    values (p_nda_id, p_version_id, 'authority.completed', v_accepted_at);
    v_completed := true;
  end if;

  return jsonb_build_object(
    'nda_id', p_nda_id, 'version_id', p_version_id, 'signer_id', p_signer_id,
    'signed_at', v_accepted_at, 'completed', v_completed
  );
end $$;

revoke all on function public.nda_authority_sign_version(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.nda_authority_sign_version(uuid,uuid,uuid,text,text)
  to service_role;
alter function public.nda_authority_sign_version(uuid,uuid,uuid,text,text)
  owner to postgres;

revoke execute on function public.nda_authority_guard_contract_update() from public;
revoke execute on function public.nda_authority_guard_version_update() from public;
revoke execute on function public.nda_authority_audit_version_transition() from public;
revoke execute on function public.nda_authority_guard_signer_update() from public;

commit;

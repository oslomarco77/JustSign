-- SD-407B.1 — completed NDA Workspace binding authority reservation.
-- Apply after nda_authority_foundation.sql and nda_authority_signing.sql.
-- This migration records e-sign-side authority only; it never mutates Workspace.

begin;

alter table public.nda_authority_versions
  add constraint nda_authority_versions_hash_reference_unique
  unique (nda_id, id, document_hash);

create table public.nda_workspace_binding_authorities (
  id uuid primary key default gen_random_uuid(),
  nda_id uuid not null unique
    references public.nda_authority_contracts(id) on delete restrict,
  version_id uuid not null unique,
  workspace_id uuid not null,
  binding_status text not null default 'reserved'
    check (binding_status in ('reserved','bound')),
  document_hash bytea not null check (octet_length(document_hash) = 32),
  authority_package_reference text not null,
  actor_principal text not null
    check (actor_principal ~ '^[A-Za-z0-9._:-]{3,128}$'),
  reservation_key text not null unique
    check (reservation_key ~ '^ndawb_[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  bound_at timestamptz,
  unique (nda_id, version_id, id),
  foreign key (nda_id, version_id, document_hash)
    references public.nda_authority_versions(nda_id, id, document_hash) on delete restrict,
  check (authority_package_reference =
    'nda-authority:' || nda_id::text || '/' || version_id::text),
  check (
    (binding_status = 'reserved' and bound_at is null)
    or (binding_status = 'bound' and bound_at is not null)
  )
);

create table public.nda_workspace_binding_audit_events (
  id bigint generated always as identity primary key,
  binding_id uuid not null,
  nda_id uuid not null,
  version_id uuid not null,
  requested_workspace_id uuid not null,
  event_type text not null check (event_type in (
    'workspace_binding.reserved',
    'workspace_binding.idempotent_replay',
    'workspace_binding.conflict'
  )),
  actor_principal text not null
    check (actor_principal ~ '^[A-Za-z0-9._:-]{3,128}$'),
  correlation_key text not null
    check (correlation_key ~ '^ndawb_[0-9a-f]{64}$'),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (nda_id, version_id, binding_id)
    references public.nda_workspace_binding_authorities(nda_id, version_id, id) on delete restrict
);

create index nda_workspace_binding_target_idx
  on public.nda_workspace_binding_authorities(workspace_id, created_at);
create index nda_workspace_binding_audit_authority_idx
  on public.nda_workspace_binding_audit_events(nda_id, version_id, occurred_at, id);

create or replace function public.nda_workspace_binding_guard_update()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id <> old.id or new.nda_id <> old.nda_id or new.version_id <> old.version_id
     or new.workspace_id <> old.workspace_id or new.document_hash <> old.document_hash
     or new.authority_package_reference <> old.authority_package_reference
     or new.actor_principal <> old.actor_principal
     or new.reservation_key <> old.reservation_key or new.created_at <> old.created_at then
    raise exception 'immutable nda workspace binding authority';
  end if;
  if old.binding_status = new.binding_status then
    if new.bound_at is distinct from old.bound_at then
      raise exception 'immutable nda workspace binding lifecycle evidence';
    end if;
    return new;
  end if;
  if old.binding_status <> 'reserved' or new.binding_status <> 'bound'
     or new.bound_at is null then
    raise exception 'invalid nda workspace binding transition';
  end if;
  return new;
end $$;

create trigger nda_workspace_binding_immutable
before update on public.nda_workspace_binding_authorities
for each row execute function public.nda_workspace_binding_guard_update();

create or replace function public.nda_workspace_binding_audit_append_only()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'nda workspace binding audit events are append-only';
end $$;

create trigger nda_workspace_binding_audit_append_only
before update or delete on public.nda_workspace_binding_audit_events
for each row execute function public.nda_workspace_binding_audit_append_only();

alter table public.nda_workspace_binding_authorities enable row level security;
alter table public.nda_workspace_binding_audit_events enable row level security;

revoke all on public.nda_workspace_binding_authorities from anon, authenticated, service_role;
revoke all on public.nda_workspace_binding_audit_events from anon, authenticated, service_role;

create or replace function public.nda_authority_reserve_workspace_binding(
  p_nda_id uuid,
  p_version_id uuid,
  p_workspace_id uuid,
  p_actor_principal text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_contract public.nda_authority_contracts%rowtype;
  v_version public.nda_authority_versions%rowtype;
  v_binding public.nda_workspace_binding_authorities%rowtype;
  v_key text;
  v_reference text;
begin
  if p_nda_id is null or p_version_id is null or p_workspace_id is null
     or p_actor_principal is null
     or p_actor_principal !~ '^[A-Za-z0-9._:-]{3,128}$' then
    raise exception 'nda_binding_not_eligible';
  end if;

  select * into v_contract from public.nda_authority_contracts
  where id = p_nda_id for update;
  if not found or v_contract.lifecycle_status <> 'completed'
     or v_contract.completed_version_id <> p_version_id
     or v_contract.completed_at is null then
    raise exception 'nda_binding_not_eligible';
  end if;

  select * into v_version from public.nda_authority_versions
  where nda_id = p_nda_id and id = p_version_id for update;
  if not found or v_version.lifecycle_status <> 'completed'
     or v_version.completed_at is null
     or v_version.completed_at <> v_contract.completed_at
     or v_version.canonical_document <> v_version.canonical_payload::jsonb
     or extensions.digest(convert_to(v_version.canonical_payload, 'UTF8'), 'sha256')
       <> v_version.document_hash
     or not exists (
       select 1 from public.nda_authority_signers
       where nda_id = p_nda_id and version_id = p_version_id and is_required
     ) or exists (
       select 1 from public.nda_authority_signers
       where nda_id = p_nda_id and version_id = p_version_id
         and is_required and signing_status <> 'signed'
     ) then
    raise exception 'nda_binding_not_eligible';
  end if;

  v_key := 'ndawb_' || encode(extensions.digest(convert_to(
    concat_ws(E'\n', 'SIGNDEE-NDA-WORKSPACE-BINDING-V1', p_nda_id::text,
      p_version_id::text, p_workspace_id::text), 'UTF8'), 'sha256'), 'hex');
  v_reference := 'nda-authority:' || p_nda_id::text || '/' || p_version_id::text;

  select * into v_binding from public.nda_workspace_binding_authorities
  where nda_id = p_nda_id for update;
  if found then
    if v_binding.version_id <> p_version_id
       or v_binding.workspace_id <> p_workspace_id
       or v_binding.document_hash <> v_version.document_hash then
      insert into public.nda_workspace_binding_audit_events(
        binding_id, nda_id, version_id, requested_workspace_id,
        event_type, actor_principal, correlation_key
      ) values (
        v_binding.id, v_binding.nda_id, v_binding.version_id, p_workspace_id,
        'workspace_binding.conflict', p_actor_principal, v_key
      );
      return jsonb_build_object('outcome', 'conflict');
    end if;

    insert into public.nda_workspace_binding_audit_events(
      binding_id, nda_id, version_id, requested_workspace_id,
      event_type, actor_principal, correlation_key
    ) values (
      v_binding.id, p_nda_id, p_version_id, p_workspace_id,
      'workspace_binding.idempotent_replay', p_actor_principal, v_key
    );
    return jsonb_build_object(
      'outcome', 'reserved', 'created', false,
      'binding_id', v_binding.id, 'nda_id', v_binding.nda_id,
      'version_id', v_binding.version_id, 'workspace_id', v_binding.workspace_id,
      'binding_status', v_binding.binding_status,
      'document_hash', 'sha256:' || encode(v_binding.document_hash, 'hex'),
      'authority_package_reference', v_binding.authority_package_reference
    );
  end if;

  insert into public.nda_workspace_binding_authorities(
    nda_id, version_id, workspace_id, document_hash,
    authority_package_reference, actor_principal, reservation_key
  ) values (
    p_nda_id, p_version_id, p_workspace_id, v_version.document_hash,
    v_reference, p_actor_principal, v_key
  ) returning * into v_binding;

  insert into public.nda_workspace_binding_audit_events(
    binding_id, nda_id, version_id, requested_workspace_id,
    event_type, actor_principal, correlation_key
  ) values (
    v_binding.id, p_nda_id, p_version_id, p_workspace_id,
    'workspace_binding.reserved', p_actor_principal, v_key
  );

  return jsonb_build_object(
    'outcome', 'reserved', 'created', true,
    'binding_id', v_binding.id, 'nda_id', v_binding.nda_id,
    'version_id', v_binding.version_id, 'workspace_id', v_binding.workspace_id,
    'binding_status', v_binding.binding_status,
    'document_hash', 'sha256:' || encode(v_binding.document_hash, 'hex'),
    'authority_package_reference', v_binding.authority_package_reference
  );
end $$;

revoke all on function public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)
  to service_role;
alter function public.nda_authority_reserve_workspace_binding(uuid,uuid,uuid,text)
  owner to postgres;

revoke execute on function public.nda_workspace_binding_guard_update() from public;
revoke execute on function public.nda_workspace_binding_audit_append_only() from public;

commit;

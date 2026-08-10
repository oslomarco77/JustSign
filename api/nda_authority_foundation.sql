-- SD-407A.2A — backend-authoritative NDA foundation.
-- Additive only. Legacy public.nda_contracts rows remain legacy and are never
-- promoted into this authority model. Inspect locally; do not apply remotely
-- as part of this ticket.

create extension if not exists pgcrypto;

create table if not exists public.nda_authority_contracts (
  id uuid primary key,
  authority_schema text not null default 'signdee.nda.authority.v1'
    check (authority_schema = 'signdee.nda.authority.v1'),
  source_kind text not null default 'backend_authoritative'
    check (source_kind = 'backend_authoritative'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.nda_authority_versions (
  id uuid primary key,
  nda_id uuid not null references public.nda_authority_contracts(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  canonical_schema text not null check (canonical_schema = 'signdee.nda.document.v1'),
  canonical_payload text not null,
  canonical_document jsonb not null check (jsonb_typeof(canonical_document) = 'object'),
  document_hash bytea not null check (octet_length(document_hash) = 32),
  lifecycle_status text not null check (lifecycle_status in ('draft','issued','void','superseded')),
  issued_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  superseded_by_version_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (nda_id, version_number),
  unique (nda_id, id),
  foreign key (nda_id, superseded_by_version_id)
    references public.nda_authority_versions(nda_id, id) on delete restrict,
  check (canonical_document = canonical_payload::jsonb),
  check (extensions.digest(convert_to(canonical_payload, 'UTF8'), 'sha256') = document_hash),
  check (
    (lifecycle_status = 'draft' and issued_at is null and invalidated_at is null and invalidation_reason is null and superseded_by_version_id is null)
    or (lifecycle_status = 'issued' and issued_at is not null and invalidated_at is null and invalidation_reason is null and superseded_by_version_id is null)
    or (lifecycle_status = 'void' and invalidated_at is not null and invalidation_reason is not null and length(btrim(invalidation_reason)) > 0 and superseded_by_version_id is null)
    or (lifecycle_status = 'superseded' and issued_at is not null and invalidated_at is not null and invalidation_reason is not null and length(btrim(invalidation_reason)) > 0 and superseded_by_version_id is not null)
  )
);

create table if not exists public.nda_authority_signers (
  id uuid primary key,
  nda_id uuid not null,
  version_id uuid not null,
  party_ref uuid not null,
  signer_role text not null check (signer_role in ('discloser','recipient','witness','approver')),
  signing_order integer not null default 1 check (signing_order > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (nda_id, version_id, party_ref),
  unique (nda_id, version_id, id),
  unique (nda_id, version_id, signing_order),
  foreign key (nda_id, version_id)
    references public.nda_authority_versions(nda_id, id) on delete restrict
);

create table if not exists public.nda_authority_capabilities (
  id uuid primary key default gen_random_uuid(),
  nda_id uuid not null,
  version_id uuid not null,
  signer_id uuid not null,
  capability_digest bytea not null check (octet_length(capability_digest) = 32),
  status text not null default 'active' check (status in ('active','consumed','revoked','expired')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (capability_digest),
  foreign key (nda_id, version_id, signer_id)
    references public.nda_authority_signers(nda_id, version_id, id) on delete restrict,
  check (expires_at > created_at),
  check ((status = 'consumed') = (consumed_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (consumed_at is null or revoked_at is null)
);

create table if not exists public.nda_authority_audit_events (
  id bigint generated always as identity primary key,
  nda_id uuid not null references public.nda_authority_contracts(id) on delete restrict,
  version_id uuid,
  signer_id uuid,
  event_type text not null check (event_type in (
    'authority.created','version.issued','capability.issued',
    'capability.revoked','capability.consumed','version.voided','version.superseded'
  )),
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data) = 'object'),
  occurred_at timestamptz not null default clock_timestamp(),
  check (signer_id is null or version_id is not null),
  foreign key (nda_id, version_id)
    references public.nda_authority_versions(nda_id, id) on delete restrict,
  foreign key (nda_id, version_id, signer_id)
    references public.nda_authority_signers(nda_id, version_id, id) on delete restrict
);

create unique index if not exists nda_authority_required_role_once
  on public.nda_authority_signers (nda_id, version_id, signer_role)
  where signer_role in ('discloser','recipient');

create index if not exists nda_authority_versions_nda_idx
  on public.nda_authority_versions (nda_id, version_number desc);
create index if not exists nda_authority_signers_version_idx
  on public.nda_authority_signers (version_id, signing_order);
create index if not exists nda_authority_capabilities_signer_idx
  on public.nda_authority_capabilities (signer_id, status, expires_at);
create index if not exists nda_authority_audit_nda_idx
  on public.nda_authority_audit_events (nda_id, occurred_at, id);

create or replace function public.nda_authority_enforce_version_sequence()
returns trigger language plpgsql as $$
declare
  expected integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.nda_id::text, 0));
  select coalesce(max(version_number), 0) + 1 into expected
  from public.nda_authority_versions where nda_id = new.nda_id;
  if new.version_number <> expected then
    raise exception 'nda authority version must be sequential';
  end if;
  return new;
end $$;

drop trigger if exists nda_authority_version_sequence on public.nda_authority_versions;
create trigger nda_authority_version_sequence before insert on public.nda_authority_versions
for each row execute function public.nda_authority_enforce_version_sequence();

create or replace function public.nda_authority_guard_version_update()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.nda_id <> old.nda_id
     or new.version_number <> old.version_number
     or new.canonical_schema <> old.canonical_schema
     or new.canonical_payload <> old.canonical_payload
     or new.canonical_document <> old.canonical_document
     or new.document_hash <> old.document_hash then
    raise exception 'immutable nda authority version';
  end if;
  if old.lifecycle_status = new.lifecycle_status then return new; end if;
  if old.lifecycle_status = 'draft' and new.lifecycle_status not in ('issued','void') then
    raise exception 'invalid nda authority lifecycle transition';
  elsif old.lifecycle_status = 'issued' and new.lifecycle_status not in ('void','superseded') then
    raise exception 'invalid nda authority lifecycle transition';
  elsif old.lifecycle_status in ('void','superseded') then
    raise exception 'terminal nda authority version is immutable';
  end if;
  if old.lifecycle_status = 'issued' and exists (
    select 1 from public.nda_authority_capabilities
    where nda_id = old.nda_id and version_id = old.id and status = 'active'
  ) then
    raise exception 'active capabilities must be revoked before invalidation';
  end if;
  return new;
end $$;

drop trigger if exists nda_authority_version_immutable on public.nda_authority_versions;
create trigger nda_authority_version_immutable before update on public.nda_authority_versions
for each row execute function public.nda_authority_guard_version_update();

create or replace function public.nda_authority_audit_version_transition()
returns trigger language plpgsql as $$
begin
  if old.lifecycle_status <> new.lifecycle_status and new.lifecycle_status in ('void','superseded') then
    insert into public.nda_authority_audit_events (nda_id, version_id, event_type, event_data)
    values (new.nda_id, new.id,
      case when new.lifecycle_status = 'superseded' then 'version.superseded' else 'version.voided' end,
      jsonb_build_object('reason', new.invalidation_reason,
        'superseded_by_version_id', new.superseded_by_version_id));
  end if;
  return new;
end $$;

drop trigger if exists nda_authority_version_transition_audit on public.nda_authority_versions;
create trigger nda_authority_version_transition_audit after update on public.nda_authority_versions
for each row execute function public.nda_authority_audit_version_transition();

create or replace function public.nda_authority_guard_signer_update()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.nda_id <> old.nda_id or new.version_id <> old.version_id
     or new.party_ref <> old.party_ref or new.signer_role <> old.signer_role
     or new.signing_order <> old.signing_order then
    raise exception 'immutable nda authority signer mapping';
  end if;
  return new;
end $$;

drop trigger if exists nda_authority_signer_immutable on public.nda_authority_signers;
create trigger nda_authority_signer_immutable before update on public.nda_authority_signers
for each row execute function public.nda_authority_guard_signer_update();

create or replace function public.nda_authority_audit_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'nda authority audit events are append-only';
end $$;

drop trigger if exists nda_authority_audit_append_only on public.nda_authority_audit_events;
create trigger nda_authority_audit_append_only before update or delete on public.nda_authority_audit_events
for each row execute function public.nda_authority_audit_append_only();

alter table public.nda_authority_contracts enable row level security;
alter table public.nda_authority_versions enable row level security;
alter table public.nda_authority_signers enable row level security;
alter table public.nda_authority_capabilities enable row level security;
alter table public.nda_authority_audit_events enable row level security;

revoke all on public.nda_authority_contracts from anon, authenticated, service_role;
revoke all on public.nda_authority_versions from anon, authenticated, service_role;
revoke all on public.nda_authority_signers from anon, authenticated, service_role;
revoke all on public.nda_authority_capabilities from anon, authenticated, service_role;
revoke all on public.nda_authority_audit_events from anon, authenticated, service_role;

create or replace function public.nda_authority_create_initial_version(
  p_nda_id uuid,
  p_version_id uuid,
  p_canonical_schema text,
  p_canonical_payload text,
  p_canonical_document jsonb,
  p_document_hash text,
  p_signers jsonb
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  s jsonb;
begin
  if p_nda_id is null or p_version_id is null or p_canonical_schema is null
     or p_canonical_payload is null or p_canonical_document is null
     or p_document_hash is null or p_signers is null
     or p_canonical_schema <> 'signdee.nda.document.v1'
     or p_document_hash !~ '^[0-9a-f]{64}$'
     or p_canonical_document <> p_canonical_payload::jsonb
     or encode(extensions.digest(convert_to(p_canonical_payload, 'UTF8'), 'sha256'), 'hex') <> p_document_hash
     or p_canonical_document->>'canonical_schema' <> p_canonical_schema
     or p_canonical_document->>'nda_id' <> p_nda_id::text
     or p_canonical_document->>'version_id' <> p_version_id::text
     or p_canonical_document->>'version_number' <> '1'
     or coalesce(jsonb_typeof(p_signers), '') <> 'array'
     or jsonb_array_length(p_signers) <> 2
     or coalesce(jsonb_typeof(p_canonical_document->'parties'), '') <> 'array'
     or jsonb_array_length(p_canonical_document->'parties') <> 2
     or (select count(*) from jsonb_array_elements(p_signers) x where x->>'role' = 'discloser') <> 1
     or (select count(*) from jsonb_array_elements(p_signers) x where x->>'role' = 'recipient') <> 1
     or exists (
       select 1 from jsonb_array_elements(p_signers) x
       where not exists (
         select 1 from jsonb_array_elements(p_canonical_document->'parties') p
         where p->>'signer_id' = x->>'id'
           and p->>'party_ref' = x->>'party_ref'
           and p->>'role' = x->>'role'
       )
     ) then
    raise exception 'invalid nda authority package';
  end if;

  insert into public.nda_authority_contracts (id) values (p_nda_id);
  insert into public.nda_authority_versions (
    id, nda_id, version_number, canonical_schema, canonical_payload, canonical_document,
    document_hash, lifecycle_status, issued_at
  ) values (
    p_version_id, p_nda_id, 1, p_canonical_schema, p_canonical_payload, p_canonical_document,
    decode(p_document_hash, 'hex'), 'issued', clock_timestamp()
  );

  for s in select value from jsonb_array_elements(p_signers) loop
    insert into public.nda_authority_signers
      (id, nda_id, version_id, party_ref, signer_role, signing_order)
    values (
      (s->>'id')::uuid, p_nda_id, p_version_id, (s->>'party_ref')::uuid,
      s->>'role', case when s->>'role' = 'discloser' then 1 else 2 end
    );
    insert into public.nda_authority_capabilities
      (nda_id, version_id, signer_id, capability_digest, expires_at)
    values (
      p_nda_id, p_version_id, (s->>'id')::uuid,
      decode(s->>'capability_digest', 'hex'), (s->>'expires_at')::timestamptz
    );
    insert into public.nda_authority_audit_events
      (nda_id, version_id, signer_id, event_type, event_data)
    values (
      p_nda_id, p_version_id, (s->>'id')::uuid, 'capability.issued',
      jsonb_build_object('expires_at', s->>'expires_at')
    );
  end loop;

  insert into public.nda_authority_audit_events (nda_id, version_id, event_type)
  values (p_nda_id, p_version_id, 'authority.created'),
         (p_nda_id, p_version_id, 'version.issued');
end $$;

revoke all on function public.nda_authority_create_initial_version(uuid,uuid,text,text,jsonb,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.nda_authority_create_initial_version(uuid,uuid,text,text,jsonb,text,jsonb)
  to service_role;
alter function public.nda_authority_create_initial_version(uuid,uuid,text,text,jsonb,text,jsonb)
  owner to postgres;

create or replace function public.nda_authority_invalidate_version(
  p_nda_id uuid,
  p_version_id uuid,
  p_target_status text,
  p_reason text,
  p_superseded_by_version_id uuid default null
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v public.nda_authority_versions%rowtype;
  revoked_signer uuid;
begin
  if p_target_status not in ('void','superseded') or length(btrim(coalesce(p_reason,''))) = 0 then
    raise exception 'invalid nda authority invalidation';
  end if;
  select * into v from public.nda_authority_versions
  where nda_id = p_nda_id and id = p_version_id for update;
  if not found or v.lifecycle_status <> 'issued' then
    raise exception 'nda authority version is not issued';
  end if;
  if (p_target_status = 'superseded') <> (p_superseded_by_version_id is not null) then
    raise exception 'invalid superseding version';
  end if;
  if p_superseded_by_version_id is not null and not exists (
    select 1 from public.nda_authority_versions
    where nda_id = p_nda_id
      and id = p_superseded_by_version_id
      and id <> p_version_id
      and lifecycle_status = 'issued'
      and version_number > v.version_number
  ) then
    raise exception 'invalid superseding version';
  end if;

  for revoked_signer in
    update public.nda_authority_capabilities
    set status = 'revoked', revoked_at = clock_timestamp()
    where nda_id = p_nda_id and version_id = p_version_id and status = 'active'
    returning signer_id
  loop
    insert into public.nda_authority_audit_events
      (nda_id, version_id, signer_id, event_type)
    values (p_nda_id, p_version_id, revoked_signer, 'capability.revoked');
  end loop;

  update public.nda_authority_versions
  set lifecycle_status = p_target_status,
      invalidated_at = clock_timestamp(),
      invalidation_reason = btrim(p_reason),
      superseded_by_version_id = p_superseded_by_version_id
  where nda_id = p_nda_id and id = p_version_id;

end $$;

revoke all on function public.nda_authority_invalidate_version(uuid,uuid,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.nda_authority_invalidate_version(uuid,uuid,text,text,uuid)
  to service_role;
alter function public.nda_authority_invalidate_version(uuid,uuid,text,text,uuid)
  owner to postgres;

revoke execute on function public.nda_authority_enforce_version_sequence() from public;
revoke execute on function public.nda_authority_guard_version_update() from public;
revoke execute on function public.nda_authority_audit_version_transition() from public;
revoke execute on function public.nda_authority_guard_signer_update() from public;
revoke execute on function public.nda_authority_audit_append_only() from public;

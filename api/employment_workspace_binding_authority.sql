-- SD-408A.4 — Employment-specific Workspace binding authority.
-- Apply after employment_signed_evidence_authority.sql. This records source-side
-- binding identity only; Workspace authorization and persistence remain Workspace-owned.
begin;

alter table public.employment_signed_evidence_authorities
  add constraint employment_signed_evidence_binding_fk_unique
  unique (employment_id,version_id,document_hash,signed_document_reference);

create table public.employment_workspace_binding_authorities (
  id uuid primary key default gen_random_uuid(),
  employment_id uuid not null unique
    references public.employment_authority_contracts(id) on delete restrict,
  version_id uuid not null unique,
  workspace_id uuid not null,
  binding_status text not null default 'reserved'
    check (binding_status in ('reserved','bound')),
  document_hash bytea not null check (octet_length(document_hash)=32),
  signed_document_reference text not null
    check (signed_document_reference~'^sde_emp_[0-9a-f]{64}$'),
  actor_principal text not null
    check (actor_principal~'^[A-Za-z0-9._:-]{3,128}$'),
  reservation_key text not null unique
    check (reservation_key~'^empwb_[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  bound_at timestamptz,
  workspace_result_reference uuid,
  unique (employment_id,version_id,id),
  foreign key (employment_id,version_id,document_hash,signed_document_reference)
    references public.employment_signed_evidence_authorities(
      employment_id,version_id,document_hash,signed_document_reference) on delete restrict,
  check ((binding_status='reserved' and bound_at is null and workspace_result_reference is null)
    or (binding_status='bound' and bound_at is not null and workspace_result_reference is not null))
);

create table public.employment_workspace_binding_audit_events (
  id bigint generated always as identity primary key,
  binding_id uuid not null,
  employment_id uuid not null,
  version_id uuid not null,
  requested_workspace_id uuid not null,
  event_type text not null check (event_type in (
    'workspace_binding.reserved','workspace_binding.idempotent_replay','workspace_binding.conflict',
    'workspace_binding.bound','workspace_binding.bound_replay','workspace_binding.bound_conflict')),
  actor_principal text not null check (actor_principal~'^[A-Za-z0-9._:-]{3,128}$'),
  correlation_key text not null check (correlation_key~'^empwb_[0-9a-f]{64}$'),
  workspace_result_reference uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (employment_id,version_id,binding_id)
    references public.employment_workspace_binding_authorities(employment_id,version_id,id)
      on delete restrict
);

create index employment_workspace_binding_target_idx
  on public.employment_workspace_binding_authorities(workspace_id,created_at);
create index employment_workspace_binding_audit_idx
  on public.employment_workspace_binding_audit_events(employment_id,version_id,occurred_at,id);

create function public.employment_workspace_binding_guard_update()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.id<>old.id or new.employment_id<>old.employment_id or new.version_id<>old.version_id
    or new.workspace_id<>old.workspace_id or new.document_hash<>old.document_hash
    or new.signed_document_reference<>old.signed_document_reference
    or new.actor_principal<>old.actor_principal or new.reservation_key<>old.reservation_key
    or new.created_at<>old.created_at then
    raise exception 'immutable employment workspace binding authority';end if;
  if old.binding_status=new.binding_status then
    if new.bound_at is distinct from old.bound_at
      or new.workspace_result_reference is distinct from old.workspace_result_reference then
      raise exception 'immutable employment workspace binding lifecycle evidence';end if;
    return new;
  end if;
  if old.binding_status<>'reserved' or new.binding_status<>'bound'
    or new.bound_at is null or new.workspace_result_reference is null then
    raise exception 'invalid employment workspace binding transition';end if;
  return new;
end $$;
create trigger employment_workspace_binding_immutable before update
on public.employment_workspace_binding_authorities for each row
execute function public.employment_workspace_binding_guard_update();

create function public.employment_workspace_binding_audit_append_only()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'employment workspace binding audit events are append-only';end $$;
create trigger employment_workspace_binding_audit_append_only before update or delete
on public.employment_workspace_binding_audit_events for each row
execute function public.employment_workspace_binding_audit_append_only();

alter table public.employment_workspace_binding_authorities enable row level security;
alter table public.employment_workspace_binding_audit_events enable row level security;
revoke all on public.employment_workspace_binding_authorities from anon,authenticated,service_role;
revoke all on public.employment_workspace_binding_audit_events from anon,authenticated,service_role;
revoke all on sequence public.employment_workspace_binding_audit_events_id_seq
  from anon,authenticated,service_role;

create function public.employment_authority_reserve_workspace_binding(
  p_employment_id uuid,p_version_id uuid,p_workspace_id uuid,p_actor_principal text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare authority public.employment_authority_contracts%rowtype;
  v public.employment_authority_versions%rowtype;
  e public.employment_signed_evidence_authorities%rowtype;
  b public.employment_workspace_binding_authorities%rowtype;
  key text;
begin
  if p_employment_id is null or p_version_id is null or p_workspace_id is null
    or p_actor_principal is null or p_actor_principal!~'^[A-Za-z0-9._:-]{3,128}$' then
    raise exception 'employment_binding_not_eligible';end if;
  select * into authority from public.employment_authority_contracts
    where id=p_employment_id for update;
  if not found then raise exception 'employment_binding_not_eligible';end if;
  select * into v from public.employment_authority_versions
    where employment_id=p_employment_id and id=p_version_id for update;
  if not found or v.lifecycle_status<>'issued'
    or v.canonical_document<>v.canonical_payload::jsonb
    or extensions.digest(convert_to(v.canonical_payload,'UTF8'),'sha256')<>v.document_hash then
    raise exception 'employment_binding_not_eligible';end if;
  select * into e from public.employment_signed_evidence_authorities
    where employment_id=p_employment_id and version_id=p_version_id for update;
  if not found or (e.employment_id,e.version_id,e.document_hash) is distinct from
    (v.employment_id,v.id,v.document_hash) then
    raise exception 'employment_binding_not_eligible';end if;

  key:='empwb_'||encode(extensions.digest(convert_to(concat_ws(E'\n',
    'SIGNDEE-EMPLOYMENT-WORKSPACE-BINDING-V1',p_employment_id::text,
    p_version_id::text,p_workspace_id::text),'UTF8'),'sha256'),'hex');
  select * into b from public.employment_workspace_binding_authorities
    where employment_id=p_employment_id for update;
  if found then
    if b.version_id<>p_version_id or b.workspace_id<>p_workspace_id
      or b.document_hash<>e.document_hash
      or b.signed_document_reference<>e.signed_document_reference then
      insert into public.employment_workspace_binding_audit_events(binding_id,employment_id,
        version_id,requested_workspace_id,event_type,actor_principal,correlation_key)
      values(b.id,b.employment_id,b.version_id,p_workspace_id,'workspace_binding.conflict',
        p_actor_principal,key);
      return jsonb_build_object('outcome','conflict');
    end if;
    insert into public.employment_workspace_binding_audit_events(binding_id,employment_id,
      version_id,requested_workspace_id,event_type,actor_principal,correlation_key)
    values(b.id,b.employment_id,b.version_id,p_workspace_id,'workspace_binding.idempotent_replay',
      p_actor_principal,key);
    return jsonb_build_object('outcome','reserved','created',false,'binding_id',b.id,
      'employment_id',b.employment_id,'version_id',b.version_id,'workspace_id',b.workspace_id,
      'binding_status',b.binding_status,'document_hash','sha256:'||encode(b.document_hash,'hex'),
      'signed_document_reference',b.signed_document_reference,
      'workspace_result_reference',b.workspace_result_reference);
  end if;
  insert into public.employment_workspace_binding_authorities(employment_id,version_id,workspace_id,
    document_hash,signed_document_reference,actor_principal,reservation_key)
  values(p_employment_id,p_version_id,p_workspace_id,e.document_hash,e.signed_document_reference,
    p_actor_principal,key) returning * into b;
  insert into public.employment_workspace_binding_audit_events(binding_id,employment_id,
    version_id,requested_workspace_id,event_type,actor_principal,correlation_key)
  values(b.id,b.employment_id,b.version_id,p_workspace_id,'workspace_binding.reserved',
    p_actor_principal,key);
  return jsonb_build_object('outcome','reserved','created',true,'binding_id',b.id,
    'employment_id',b.employment_id,'version_id',b.version_id,'workspace_id',b.workspace_id,
    'binding_status',b.binding_status,'document_hash','sha256:'||encode(b.document_hash,'hex'),
    'signed_document_reference',b.signed_document_reference,'workspace_result_reference',null);
end $$;

create function public.employment_authority_resolve_workspace_acceptance(
  p_binding_id uuid,p_signed_document_reference text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.employment_workspace_binding_authorities%rowtype;
  e public.employment_signed_evidence_authorities%rowtype;
begin
  if p_binding_id is null or p_signed_document_reference is null
    or p_signed_document_reference!~'^sde_emp_[0-9a-f]{64}$' then
    raise exception 'employment_workspace_acceptance_not_authorized';end if;
  select * into b from public.employment_workspace_binding_authorities
    where id=p_binding_id for update;
  if not found then raise exception 'employment_workspace_acceptance_not_authorized';end if;
  select * into e from public.employment_signed_evidence_authorities
    where signed_document_reference=p_signed_document_reference;
  if not found or (b.employment_id,b.version_id,b.document_hash,b.signed_document_reference)
    is distinct from (e.employment_id,e.version_id,e.document_hash,e.signed_document_reference) then
    raise exception 'employment_workspace_acceptance_not_authorized';end if;
  return jsonb_build_object('binding_id',b.id,'binding_status',b.binding_status,
    'workspace_id',b.workspace_id,'employment_id',b.employment_id,'version_id',b.version_id,
    'version_number',e.version_number,'document_hash','sha256:'||encode(b.document_hash,'hex'),
    'signed_document_reference',e.signed_document_reference,
    'source_completed_at',e.source_completed_at,
    'signer_evidence_set_digest','sha256:'||encode(e.signer_evidence_set_digest,'hex'),
    'workspace_result_reference',b.workspace_result_reference);
end $$;

create function public.employment_authority_confirm_workspace_acceptance(
  p_binding_id uuid,p_workspace_id uuid,p_workspace_result_reference uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.employment_workspace_binding_authorities%rowtype;
  now_at timestamptz:=clock_timestamp();
begin
  if p_binding_id is null or p_workspace_id is null or p_workspace_result_reference is null then
    raise exception 'employment_workspace_confirmation_conflict';end if;
  select * into b from public.employment_workspace_binding_authorities
    where id=p_binding_id for update;
  if not found or b.workspace_id<>p_workspace_id then
    raise exception 'employment_workspace_confirmation_conflict';end if;
  if b.binding_status='bound' then
    if b.workspace_result_reference<>p_workspace_result_reference then
      insert into public.employment_workspace_binding_audit_events(binding_id,employment_id,
        version_id,requested_workspace_id,event_type,actor_principal,correlation_key,
        workspace_result_reference)
      values(b.id,b.employment_id,b.version_id,p_workspace_id,'workspace_binding.bound_conflict',
        'workspace-receiver:v1',b.reservation_key,p_workspace_result_reference);
      raise exception 'employment_workspace_confirmation_conflict';end if;
    insert into public.employment_workspace_binding_audit_events(binding_id,employment_id,
      version_id,requested_workspace_id,event_type,actor_principal,correlation_key,
      workspace_result_reference)
    values(b.id,b.employment_id,b.version_id,p_workspace_id,'workspace_binding.bound_replay',
      'workspace-receiver:v1',b.reservation_key,p_workspace_result_reference);
    return jsonb_build_object('created',false,'binding_id',b.id,'binding_status','bound',
      'workspace_id',b.workspace_id,'workspace_result_reference',b.workspace_result_reference);
  end if;
  update public.employment_workspace_binding_authorities set binding_status='bound',
    bound_at=now_at,workspace_result_reference=p_workspace_result_reference
    where id=b.id returning * into b;
  insert into public.employment_workspace_binding_audit_events(binding_id,employment_id,
    version_id,requested_workspace_id,event_type,actor_principal,correlation_key,
    workspace_result_reference,occurred_at)
  values(b.id,b.employment_id,b.version_id,p_workspace_id,'workspace_binding.bound',
    'workspace-receiver:v1',b.reservation_key,p_workspace_result_reference,now_at);
  return jsonb_build_object('created',true,'binding_id',b.id,'binding_status','bound',
    'workspace_id',b.workspace_id,'workspace_result_reference',b.workspace_result_reference);
end $$;

revoke all on function public.employment_authority_reserve_workspace_binding(uuid,uuid,uuid,text)
  from public,anon,authenticated;
revoke all on function public.employment_authority_resolve_workspace_acceptance(uuid,text)
  from public,anon,authenticated;
revoke all on function public.employment_authority_confirm_workspace_acceptance(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.employment_authority_reserve_workspace_binding(uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.employment_authority_resolve_workspace_acceptance(uuid,text)
  to service_role;
grant execute on function public.employment_authority_confirm_workspace_acceptance(uuid,uuid,uuid)
  to service_role;
alter function public.employment_authority_reserve_workspace_binding(uuid,uuid,uuid,text) owner to postgres;
alter function public.employment_authority_resolve_workspace_acceptance(uuid,text) owner to postgres;
alter function public.employment_authority_confirm_workspace_acceptance(uuid,uuid,uuid) owner to postgres;
revoke execute on function public.employment_workspace_binding_guard_update() from public;
revoke execute on function public.employment_workspace_binding_audit_append_only() from public;
commit;

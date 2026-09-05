-- SD-407B.1 — source verification and durable B.1 confirmation.
-- Apply after B.1 and the durable signed-evidence authority.
begin;

alter table public.nda_workspace_binding_authorities
  add column workspace_result_reference uuid;

alter table public.nda_workspace_binding_authorities
  drop constraint nda_workspace_binding_authorities_check,
  add constraint nda_workspace_binding_lifecycle_result_check check (
    (binding_status='reserved' and bound_at is null and workspace_result_reference is null)
    or (binding_status='bound' and bound_at is not null and workspace_result_reference is not null));

alter table public.nda_workspace_binding_audit_events
  add column workspace_result_reference uuid;

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid='public.nda_workspace_binding_audit_events'::regclass
    and contype='c' and pg_get_constraintdef(oid) like '%event_type%';
  execute format('alter table public.nda_workspace_binding_audit_events drop constraint %I',c);
end $$;
alter table public.nda_workspace_binding_audit_events
  add constraint nda_workspace_binding_audit_event_v2_check check (event_type in (
    'workspace_binding.reserved','workspace_binding.idempotent_replay','workspace_binding.conflict',
    'workspace_binding.bound','workspace_binding.bound_replay','workspace_binding.bound_conflict'));

create or replace function public.nda_workspace_binding_guard_update()
returns trigger language plpgsql set search_path=public,pg_temp as $$ begin
  if new.id<>old.id or new.nda_id<>old.nda_id or new.version_id<>old.version_id
    or new.workspace_id<>old.workspace_id or new.document_hash<>old.document_hash
    or new.authority_package_reference<>old.authority_package_reference
    or new.actor_principal<>old.actor_principal or new.reservation_key<>old.reservation_key
    or new.created_at<>old.created_at then raise exception 'immutable nda workspace binding authority'; end if;
  if old.binding_status=new.binding_status then
    if new.bound_at is distinct from old.bound_at
      or new.workspace_result_reference is distinct from old.workspace_result_reference
      then raise exception 'immutable nda workspace binding lifecycle evidence'; end if;
    return new;
  end if;
  if old.binding_status<>'reserved' or new.binding_status<>'bound'
    or new.bound_at is null or new.workspace_result_reference is null
    then raise exception 'invalid nda workspace binding transition'; end if;
  return new;
end $$;

create function public.nda_authority_resolve_workspace_acceptance(
  p_binding_id uuid,p_signed_document_reference text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.nda_workspace_binding_authorities%rowtype;
  e public.nda_signed_evidence_authorities%rowtype;
begin
  if p_binding_id is null or p_signed_document_reference is null
    or p_signed_document_reference !~ '^sde_[0-9a-f]{64}$'
    then raise exception 'nda_workspace_acceptance_not_authorized'; end if;
  select * into b from public.nda_workspace_binding_authorities where id=p_binding_id for update;
  if not found then raise exception 'nda_workspace_acceptance_not_authorized'; end if;
  select * into e from public.nda_signed_evidence_authorities
    where signed_document_reference=p_signed_document_reference;
  if not found or (b.nda_id,b.version_id,b.document_hash) is distinct from
    (e.nda_id,e.version_id,e.document_hash)
    then raise exception 'nda_workspace_acceptance_not_authorized'; end if;
  return jsonb_build_object(
    'binding_id',b.id,'binding_status',b.binding_status,'workspace_id',b.workspace_id,
    'nda_id',b.nda_id,'version_id',b.version_id,'version_number',e.version_number,
    'document_hash','sha256:'||encode(b.document_hash,'hex'),
    'authority_package_reference',b.authority_package_reference,
    'signed_document_reference',e.signed_document_reference,
    'source_completed_at',e.source_completed_at,
    'signer_evidence_set_digest','sha256:'||encode(e.signer_evidence_set_digest,'hex'),
    'workspace_result_reference',b.workspace_result_reference);
end $$;

create function public.nda_authority_confirm_workspace_acceptance(
  p_binding_id uuid,p_workspace_id uuid,p_workspace_result_reference uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.nda_workspace_binding_authorities%rowtype; now_at timestamptz:=clock_timestamp();
begin
  if p_binding_id is null or p_workspace_id is null or p_workspace_result_reference is null
    then raise exception 'nda_workspace_confirmation_conflict'; end if;
  select * into b from public.nda_workspace_binding_authorities where id=p_binding_id for update;
  if not found or b.workspace_id<>p_workspace_id then
    raise exception 'nda_workspace_confirmation_conflict'; end if;
  if b.binding_status='bound' then
    if b.workspace_result_reference<>p_workspace_result_reference then
      insert into public.nda_workspace_binding_audit_events(binding_id,nda_id,version_id,
        requested_workspace_id,event_type,actor_principal,correlation_key,workspace_result_reference)
      values(b.id,b.nda_id,b.version_id,p_workspace_id,'workspace_binding.bound_conflict',
        'workspace-receiver:v1',b.reservation_key,p_workspace_result_reference);
      raise exception 'nda_workspace_confirmation_conflict';
    end if;
    insert into public.nda_workspace_binding_audit_events(binding_id,nda_id,version_id,
      requested_workspace_id,event_type,actor_principal,correlation_key,workspace_result_reference)
    values(b.id,b.nda_id,b.version_id,p_workspace_id,'workspace_binding.bound_replay',
      'workspace-receiver:v1',b.reservation_key,p_workspace_result_reference);
    return jsonb_build_object('created',false,'binding_id',b.id,'binding_status','bound',
      'workspace_id',b.workspace_id,'workspace_result_reference',b.workspace_result_reference);
  end if;
  update public.nda_workspace_binding_authorities set binding_status='bound',bound_at=now_at,
    workspace_result_reference=p_workspace_result_reference where id=b.id returning * into b;
  insert into public.nda_workspace_binding_audit_events(binding_id,nda_id,version_id,
    requested_workspace_id,event_type,actor_principal,correlation_key,occurred_at,workspace_result_reference)
  values(b.id,b.nda_id,b.version_id,p_workspace_id,'workspace_binding.bound',
    'workspace-receiver:v1',b.reservation_key,now_at,p_workspace_result_reference);
  return jsonb_build_object('created',true,'binding_id',b.id,'binding_status','bound',
    'workspace_id',b.workspace_id,'workspace_result_reference',b.workspace_result_reference);
end $$;

revoke all on function public.nda_authority_resolve_workspace_acceptance(uuid,text)
  from public,anon,authenticated;
revoke all on function public.nda_authority_confirm_workspace_acceptance(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.nda_authority_resolve_workspace_acceptance(uuid,text) to service_role;
grant execute on function public.nda_authority_confirm_workspace_acceptance(uuid,uuid,uuid) to service_role;
alter function public.nda_authority_resolve_workspace_acceptance(uuid,text) owner to postgres;
alter function public.nda_authority_confirm_workspace_acceptance(uuid,uuid,uuid) owner to postgres;
commit;

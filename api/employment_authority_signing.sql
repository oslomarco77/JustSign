-- SD-408A.2 — version-bound Employment signers and transactional signing.
-- Apply after employment_authority_version.sql. Legacy emp_contracts signing
-- state is intentionally neither read nor promoted by this authority.
begin;

create table public.employment_authority_signers (
  id uuid primary key,
  employment_id uuid not null,
  version_id uuid not null,
  signer_role text not null check (signer_role in ('employer','employee')),
  signer_identity_digest bytea not null check (octet_length(signer_identity_digest)=32),
  is_required boolean not null default true check (is_required),
  signing_status text not null default 'pending' check (signing_status in ('pending','signed')),
  signed_at timestamptz,
  consent_schema text,
  signature_input_digest bytea,
  signing_action_digest bytea,
  created_at timestamptz not null default clock_timestamp(),
  unique (employment_id,version_id,signer_role),
  unique (employment_id,version_id,id),
  foreign key (employment_id,version_id)
    references public.employment_authority_versions(employment_id,id) on delete restrict,
  check (
    (signing_status='pending' and signed_at is null and consent_schema is null
      and signature_input_digest is null and signing_action_digest is null)
    or
    (signing_status='signed' and signed_at is not null
      and consent_schema='signdee.employment.signing-consent.v1'
      and octet_length(signature_input_digest)=32
      and octet_length(signing_action_digest)=32)
  )
);

create table public.employment_authority_signing_capabilities (
  id uuid primary key,
  employment_id uuid not null,
  version_id uuid not null,
  signer_id uuid not null,
  capability_digest bytea not null unique check (octet_length(capability_digest)=32),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (employment_id,version_id,signer_id),
  foreign key (employment_id,version_id,signer_id)
    references public.employment_authority_signers(employment_id,version_id,id) on delete restrict,
  check (expires_at>created_at),
  check (not (revoked_at is not null and consumed_at is not null))
);

create table public.employment_authority_signing_audit_events (
  id bigint generated always as identity primary key,
  employment_id uuid not null,
  version_id uuid not null,
  signer_id uuid not null,
  event_type text not null check (event_type in
    ('signer.authorized','signer.signed','capability.consumed')),
  event_data jsonb not null default '{}'::jsonb check (jsonb_typeof(event_data)='object'),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (employment_id,version_id,signer_id)
    references public.employment_authority_signers(employment_id,version_id,id) on delete restrict
);

create index employment_authority_signers_version_status_idx
  on public.employment_authority_signers(employment_id,version_id,signing_status);
create index employment_authority_capabilities_expiry_idx
  on public.employment_authority_signing_capabilities(expires_at)
  where consumed_at is null and revoked_at is null;
create index employment_authority_signing_audit_version_idx
  on public.employment_authority_signing_audit_events(employment_id,version_id,occurred_at);

create function public.employment_authority_signer_guard()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.id<>old.id or new.employment_id<>old.employment_id or new.version_id<>old.version_id
    or new.signer_role<>old.signer_role or new.signer_identity_digest<>old.signer_identity_digest
    or new.is_required<>old.is_required or new.created_at<>old.created_at then
    raise exception 'immutable employment signer authority';
  end if;
  if old.signing_status='pending' and new.signing_status='signed'
    and old.signed_at is null and old.consent_schema is null
    and old.signature_input_digest is null and old.signing_action_digest is null then return new; end if;
  if old.signing_status=new.signing_status and old.signed_at is not distinct from new.signed_at
    and old.consent_schema is not distinct from new.consent_schema
    and old.signature_input_digest is not distinct from new.signature_input_digest
    and old.signing_action_digest is not distinct from new.signing_action_digest then return new; end if;
  raise exception 'invalid employment signer transition';
end $$;
create trigger employment_authority_signer_guard before update
on public.employment_authority_signers for each row
execute function public.employment_authority_signer_guard();

create function public.employment_authority_capability_guard()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.id<>old.id or new.employment_id<>old.employment_id or new.version_id<>old.version_id
    or new.signer_id<>old.signer_id or new.capability_digest<>old.capability_digest
    or new.expires_at<>old.expires_at or new.created_at<>old.created_at then
    raise exception 'immutable employment signing capability';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'consumed employment signing capability is immutable'; end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'revoked employment signing capability is immutable'; end if;
  if old.consumed_at is null and old.revoked_at is null
    and ((new.consumed_at is not null and new.revoked_at is null)
      or (new.revoked_at is not null and new.consumed_at is null)) then return new; end if;
  if new.consumed_at is not distinct from old.consumed_at
    and new.revoked_at is not distinct from old.revoked_at then return new; end if;
  raise exception 'invalid employment signing capability transition';
end $$;
create trigger employment_authority_capability_guard before update
on public.employment_authority_signing_capabilities for each row
execute function public.employment_authority_capability_guard();

create function public.employment_authority_audit_append_only()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'employment signing audit is append-only'; end $$;
create trigger employment_authority_signing_audit_append_only before update or delete
on public.employment_authority_signing_audit_events for each row
execute function public.employment_authority_audit_append_only();

create function public.employment_authority_authorize_signers(
  p_version_id uuid,p_signers jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.employment_authority_versions%rowtype;s jsonb;r jsonb;
  party jsonb;identity_digest bytea;created_count integer:=0;
begin
  if p_signers is null or jsonb_typeof(p_signers)<>'array' or jsonb_array_length(p_signers)<>2
    then raise exception 'employment_signer_authority_invalid';end if;
  select * into v from public.employment_authority_versions
    where id=p_version_id for update;
  if not found or v.lifecycle_status<>'issued'
    or v.canonical_document<>v.canonical_payload::jsonb
    or extensions.digest(convert_to(v.canonical_payload,'UTF8'),'sha256')<>v.document_hash
    then raise exception 'employment_signer_authority_invalid';end if;
  if exists(select 1 from public.employment_authority_signers
    where employment_id=v.employment_id and version_id=p_version_id) then
    raise exception 'employment_signers_already_authorized';end if;
  for s in select value from jsonb_array_elements(p_signers) loop
    if (select count(*) from jsonb_object_keys(s))<>5
      or s->>'role' not in ('employer','employee')
      or (s->>'id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (s->>'capability_id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (s->>'capability_digest')!~'^[0-9a-f]{64}$'
      or (s->>'expires_at') is null
      or (s->>'expires_at')::timestamptz<=clock_timestamp()
      or (s->>'expires_at')::timestamptz>clock_timestamp()+interval '7 days'
      then raise exception 'employment_signer_authority_invalid';end if;
    select value into party from jsonb_array_elements(v.canonical_document->'parties')
      where value->>'role'=s->>'role';
    if not found or (select count(*) from jsonb_array_elements(v.canonical_document->'parties')
      where value->>'role'=s->>'role')<>1 then raise exception 'employment_signer_authority_invalid';end if;
    identity_digest:=extensions.digest(convert_to(party::text,'UTF8'),'sha256');
    insert into public.employment_authority_signers
      (id,employment_id,version_id,signer_role,signer_identity_digest)
      values((s->>'id')::uuid,v.employment_id,p_version_id,s->>'role',identity_digest);
    insert into public.employment_authority_signing_capabilities
      (id,employment_id,version_id,signer_id,capability_digest,expires_at)
      values((s->>'capability_id')::uuid,v.employment_id,p_version_id,(s->>'id')::uuid,
        decode(s->>'capability_digest','hex'),(s->>'expires_at')::timestamptz);
    insert into public.employment_authority_signing_audit_events
      (employment_id,version_id,signer_id,event_type,event_data)
      values(v.employment_id,p_version_id,(s->>'id')::uuid,'signer.authorized',
        jsonb_build_object('role',s->>'role'));
    created_count:=created_count+1;
  end loop;
  if created_count<>2 or not exists(select 1 from public.employment_authority_signers
      where employment_id=v.employment_id and version_id=p_version_id and signer_role='employer')
    or not exists(select 1 from public.employment_authority_signers
      where employment_id=v.employment_id and version_id=p_version_id and signer_role='employee')
    then raise exception 'employment_signer_authority_invalid';end if;
  select jsonb_agg(jsonb_build_object('signer_id',id,'role',signer_role) order by signer_role)
    into r from public.employment_authority_signers
    where employment_id=v.employment_id and version_id=p_version_id;
  return jsonb_build_object('employment_id',v.employment_id,'version_id',p_version_id,
    'document_hash','sha256:'||encode(v.document_hash,'hex'),'signers',r);
end $$;

create function public.employment_authority_sign_version(
  p_capability_digest text,p_signature_input_digest text,p_consent_schema text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.employment_authority_signing_capabilities%rowtype;
  authority public.employment_authority_contracts%rowtype;
  v public.employment_authority_versions%rowtype;s public.employment_authority_signers%rowtype;
  accepted timestamptz;action_digest bytea;
begin
  if p_capability_digest!~'^[0-9a-f]{64}$' or p_signature_input_digest!~'^[0-9a-f]{64}$'
    or p_consent_schema<>'signdee.employment.signing-consent.v1'
    then raise exception 'employment_signing_not_authorized';end if;
  select * into c from public.employment_authority_signing_capabilities
    where capability_digest=decode(p_capability_digest,'hex');
  if not found then raise exception 'employment_signing_not_authorized';end if;
  select * into authority from public.employment_authority_contracts
    where id=c.employment_id for update;
  if not found then raise exception 'employment_signing_not_authorized';end if;
  select * into v from public.employment_authority_versions
    where employment_id=c.employment_id and id=c.version_id for update;
  select * into s from public.employment_authority_signers
    where employment_id=c.employment_id and version_id=c.version_id and id=c.signer_id for update;
  select * into c from public.employment_authority_signing_capabilities
    where id=c.id for update;
  if not found or v.canonical_document<>v.canonical_payload::jsonb
    or extensions.digest(convert_to(v.canonical_payload,'UTF8'),'sha256')<>v.document_hash
    then raise exception 'employment_signing_not_authorized';end if;
  if c.consumed_at is not null then
    if s.signing_status='signed' and s.consent_schema=p_consent_schema
      and s.signature_input_digest=decode(p_signature_input_digest,'hex') then
      return jsonb_build_object('created',false,'employment_id',s.employment_id,
        'version_id',s.version_id,'signer_id',s.id,'signer_role',s.signer_role,
        'document_hash','sha256:'||encode(v.document_hash,'hex'),'signed_at',s.signed_at);
    end if;
    raise exception 'employment_signing_conflict';
  end if;
  if v.lifecycle_status<>'issued' or exists(select 1 from public.employment_authority_versions newer
      where newer.employment_id=v.employment_id and newer.version_number>v.version_number
        and newer.lifecycle_status='issued')
    or c.revoked_at is not null or c.expires_at<=clock_timestamp() or s.signing_status<>'pending'
    then raise exception 'employment_signing_not_authorized';end if;
  accepted:=clock_timestamp();
  action_digest:=extensions.digest(convert_to(concat_ws(E'\n',
    'SIGNDEE-EMPLOYMENT-SIGNING-ACTION-V1',s.employment_id::text,s.version_id::text,s.id::text,
    encode(v.document_hash,'hex'),encode(s.signer_identity_digest,'hex'),p_consent_schema,
    p_signature_input_digest,to_char(accepted at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),'UTF8'),'sha256');
  update public.employment_authority_signers set signing_status='signed',signed_at=accepted,
    consent_schema=p_consent_schema,signature_input_digest=decode(p_signature_input_digest,'hex'),
    signing_action_digest=action_digest where id=s.id;
  update public.employment_authority_signing_capabilities set consumed_at=accepted
    where id=c.id and consumed_at is null and revoked_at is null;
  if not found then raise exception 'employment_signing_conflict';end if;
  insert into public.employment_authority_signing_audit_events
    (employment_id,version_id,signer_id,event_type,event_data,occurred_at) values
    (s.employment_id,s.version_id,s.id,'signer.signed',jsonb_build_object('role',s.signer_role),accepted),
    (s.employment_id,s.version_id,s.id,'capability.consumed','{}'::jsonb,accepted);
  return jsonb_build_object('created',true,'employment_id',s.employment_id,
    'version_id',s.version_id,'signer_id',s.id,'signer_role',s.signer_role,
    'document_hash','sha256:'||encode(v.document_hash,'hex'),'signed_at',accepted);
end $$;

alter table public.employment_authority_signers enable row level security;
alter table public.employment_authority_signing_capabilities enable row level security;
alter table public.employment_authority_signing_audit_events enable row level security;
revoke all on public.employment_authority_signers,public.employment_authority_signing_capabilities,
  public.employment_authority_signing_audit_events from anon,authenticated,service_role;
revoke all on function public.employment_authority_authorize_signers(uuid,jsonb)
  from public,anon,authenticated;
revoke all on function public.employment_authority_sign_version(text,text,text)
  from public,anon,authenticated;
grant execute on function public.employment_authority_authorize_signers(uuid,jsonb) to service_role;
grant execute on function public.employment_authority_sign_version(text,text,text) to service_role;
alter function public.employment_authority_authorize_signers(uuid,jsonb) owner to postgres;
alter function public.employment_authority_sign_version(text,text,text) owner to postgres;
revoke execute on function public.employment_authority_signer_guard() from public;
revoke execute on function public.employment_authority_capability_guard() from public;
revoke execute on function public.employment_authority_audit_append_only() from public;

commit;

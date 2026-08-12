-- SD-408A.1 — additive Employment immutable version and hash authority.
-- Legacy emp_contracts rows remain legacy source records and are never promoted
-- automatically. Apply locally only during this ticket.
begin;

create table public.employment_authority_contracts (
  id uuid primary key,
  legacy_contract_id uuid not null unique references public.emp_contracts(id) on delete restrict,
  authority_schema text not null default 'signdee.employment.authority.v1'
    check (authority_schema='signdee.employment.authority.v1'),
  source_kind text not null default 'backend_authoritative'
    check (source_kind='backend_authoritative'),
  created_at timestamptz not null default clock_timestamp(),
  unique(id,legacy_contract_id)
);

create table public.employment_authority_versions (
  id uuid primary key,
  employment_id uuid not null references public.employment_authority_contracts(id) on delete restrict,
  legacy_contract_id uuid not null references public.emp_contracts(id) on delete restrict,
  version_number integer not null check (version_number>0),
  source_updated_at timestamptz not null,
  source_content_digest bytea not null check(octet_length(source_content_digest)=32),
  source_canonical_payload text not null check(octet_length(source_canonical_payload)<=524288),
  canonical_schema text not null check(canonical_schema='signdee.employment.document.v1'),
  canonical_payload text,
  canonical_document jsonb,
  document_hash bytea,
  lifecycle_status text not null default 'draft' check (lifecycle_status in ('draft','issued')),
  issued_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(employment_id,version_number),
  unique(employment_id,canonical_schema,source_content_digest),
  unique(employment_id,id),
  foreign key(employment_id,legacy_contract_id)
    references public.employment_authority_contracts(id,legacy_contract_id) on delete restrict,
  check (
    (lifecycle_status='draft' and canonical_payload is null
      and canonical_document is null and document_hash is null and issued_at is null)
    or
    (lifecycle_status='issued' and canonical_payload is not null and canonical_document is not null
      and document_hash is not null and octet_length(document_hash)=32 and issued_at is not null)
  ),
  check (extensions.digest(convert_to(source_canonical_payload,'UTF8'),'sha256')=source_content_digest),
  check (canonical_payload is null or canonical_document=canonical_payload::jsonb),
  check (canonical_payload is null or extensions.digest(convert_to(canonical_payload,'UTF8'),'sha256')=document_hash)
);

create index employment_authority_versions_contract_idx
  on public.employment_authority_versions(employment_id,version_number desc);

create function public.employment_authority_version_guard()
returns trigger language plpgsql set search_path=public,pg_temp as $$ begin
  if old.lifecycle_status='issued' then raise exception 'immutable employment authority version'; end if;
  if old.id<>new.id or old.employment_id<>new.employment_id
    or old.legacy_contract_id<>new.legacy_contract_id or old.version_number<>new.version_number
    or old.source_content_digest<>new.source_content_digest
    or old.source_canonical_payload<>new.source_canonical_payload or old.canonical_schema<>new.canonical_schema
    or old.created_at<>new.created_at
    then raise exception 'immutable employment version identity'; end if;
  if old.lifecycle_status='draft' and new.lifecycle_status='issued'
    and old.source_updated_at=new.source_updated_at then return new; end if;
  if old.lifecycle_status='draft' and new.lifecycle_status='draft'
    and old.id=new.id and old.employment_id=new.employment_id
    and old.legacy_contract_id=new.legacy_contract_id and old.version_number=new.version_number
    and old.source_content_digest=new.source_content_digest
    and old.source_canonical_payload=new.source_canonical_payload and old.canonical_schema=new.canonical_schema
    and old.created_at=new.created_at and old.canonical_payload is null and new.canonical_payload is null
    and old.canonical_document is null and new.canonical_document is null
    and old.document_hash is null and new.document_hash is null and old.issued_at is null and new.issued_at is null
    then return new;end if;
  raise exception 'invalid employment version transition';
end $$;
create trigger employment_authority_version_guard
before update on public.employment_authority_versions for each row
execute function public.employment_authority_version_guard();

create function public.employment_authority_prepare_version(
  p_legacy_contract_id uuid,p_employment_id uuid,p_version_id uuid,p_source_updated_at timestamptz,
  p_canonical_schema text,p_source_canonical_payload text,p_source_content_digest text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.emp_contracts%rowtype;c public.employment_authority_contracts%rowtype;
  v public.employment_authority_versions%rowtype;n integer;
begin
  if p_legacy_contract_id is null or p_employment_id is null or p_version_id is null
    or p_source_updated_at is null or p_canonical_schema<>'signdee.employment.document.v1'
    or p_source_canonical_payload is null or octet_length(p_source_canonical_payload)>524288
    or jsonb_typeof(p_source_canonical_payload::jsonb)<>'object'
    or p_source_canonical_payload::jsonb ?| array['canonical_schema','authority']
    or p_source_content_digest!~'^[0-9a-f]{64}$'
    or extensions.digest(convert_to(p_source_canonical_payload,'UTF8'),'sha256')<>decode(p_source_content_digest,'hex')
    then raise exception 'employment_version_invalid';end if;
  select * into r from public.emp_contracts where id=p_legacy_contract_id for update;
  if not found or r.updated_at<>p_source_updated_at or r.clauses is null
    or r.party_a is null or r.party_b is null then raise exception 'employment_version_source_stale';end if;
  insert into public.employment_authority_contracts(id,legacy_contract_id)
    values(p_employment_id,p_legacy_contract_id) on conflict(legacy_contract_id) do nothing;
  select * into c from public.employment_authority_contracts
    where legacy_contract_id=p_legacy_contract_id for update;
  select * into v from public.employment_authority_versions
    where employment_id=c.id and canonical_schema=p_canonical_schema
      and source_content_digest=decode(p_source_content_digest,'hex');
  if found then
    if v.source_canonical_payload<>p_source_canonical_payload then raise exception 'employment_version_source_conflict';end if;
    if v.lifecycle_status='draft' and v.source_updated_at<>r.updated_at then
      update public.employment_authority_versions set source_updated_at=r.updated_at where id=v.id returning * into v;
    end if;
    return jsonb_build_object('created',false,'employment_id',v.employment_id,
    'version_id',v.id,'version_number',v.version_number,'lifecycle_status',v.lifecycle_status);end if;
  select coalesce(max(version_number),0)+1 into n from public.employment_authority_versions where employment_id=c.id;
  insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
    source_updated_at,source_canonical_payload,source_content_digest,canonical_schema)
    values(p_version_id,c.id,p_legacy_contract_id,n,p_source_updated_at,p_source_canonical_payload,
      decode(p_source_content_digest,'hex'),p_canonical_schema) returning * into v;
  return jsonb_build_object('created',true,'employment_id',v.employment_id,
    'version_id',v.id,'version_number',v.version_number,'lifecycle_status',v.lifecycle_status);
end $$;

create function public.employment_authority_issue_version(
  p_employment_id uuid,p_version_id uuid,p_source_updated_at timestamptz,
  p_canonical_schema text,p_canonical_payload text,p_canonical_document jsonb,p_document_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare authority public.employment_authority_contracts%rowtype;
  v public.employment_authority_versions%rowtype;r public.emp_contracts%rowtype;
begin
  select * into v from public.employment_authority_versions
    where employment_id=p_employment_id and id=p_version_id;
  if not found then raise exception 'employment_version_not_found';end if;
  select * into r from public.emp_contracts where id=v.legacy_contract_id for update;
  if not found then raise exception 'employment_version_source_stale';end if;
  select * into authority from public.employment_authority_contracts
    where id=p_employment_id for update;
  if not found then raise exception 'employment_version_not_found';end if;
  select * into v from public.employment_authority_versions
    where employment_id=p_employment_id and id=p_version_id for update;
  if not found then raise exception 'employment_version_not_found';end if;
  if v.lifecycle_status='issued' then
    if v.canonical_payload=p_canonical_payload and encode(v.document_hash,'hex')=p_document_hash
      then return jsonb_build_object('created',false,'employment_id',v.employment_id,'version_id',v.id,
        'version_number',v.version_number,'lifecycle_status','issued','document_hash','sha256:'||p_document_hash);end if;
    raise exception 'employment_version_conflict';
  end if;
  if r.updated_at<>v.source_updated_at or r.updated_at<>p_source_updated_at
    then raise exception 'employment_version_source_stale';end if;
  if p_canonical_schema<>'signdee.employment.document.v1'
    or p_canonical_schema<>v.canonical_schema
    or p_canonical_document<>p_canonical_payload::jsonb
    or p_canonical_document#>>'{canonical_schema}'<>v.canonical_schema
    or (p_canonical_document-'canonical_schema'-'authority')<>v.source_canonical_payload::jsonb
    or p_canonical_document#>>'{authority,employment_id}'<>p_employment_id::text
    or p_canonical_document#>>'{authority,legacy_contract_id}'<>v.legacy_contract_id::text
    or p_canonical_document#>>'{authority,version_id}'<>p_version_id::text
    or (p_canonical_document#>>'{authority,version_number}')::integer<>v.version_number
    or p_document_hash!~'^[0-9a-f]{64}$'
    or extensions.digest(convert_to(p_canonical_payload,'UTF8'),'sha256')<>decode(p_document_hash,'hex')
    then raise exception 'employment_version_canonical_mismatch';end if;
  update public.employment_authority_versions set canonical_schema=p_canonical_schema,
    canonical_payload=p_canonical_payload,canonical_document=p_canonical_document,
    document_hash=decode(p_document_hash,'hex'),lifecycle_status='issued',issued_at=clock_timestamp()
    where id=v.id returning * into v;
  return jsonb_build_object('created',true,'employment_id',v.employment_id,'version_id',v.id,
    'version_number',v.version_number,'lifecycle_status','issued','document_hash','sha256:'||encode(v.document_hash,'hex'));
end $$;

alter table public.employment_authority_contracts enable row level security;
alter table public.employment_authority_versions enable row level security;
revoke all on public.employment_authority_contracts,public.employment_authority_versions from anon,authenticated,service_role;
revoke all on function public.employment_authority_prepare_version(uuid,uuid,uuid,timestamptz,text,text,text) from public,anon,authenticated;
revoke all on function public.employment_authority_issue_version(uuid,uuid,timestamptz,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.employment_authority_prepare_version(uuid,uuid,uuid,timestamptz,text,text,text) to service_role;
grant execute on function public.employment_authority_issue_version(uuid,uuid,timestamptz,text,text,jsonb,text) to service_role;
alter function public.employment_authority_prepare_version(uuid,uuid,uuid,timestamptz,text,text,text) owner to postgres;
alter function public.employment_authority_issue_version(uuid,uuid,timestamptz,text,text,jsonb,text) owner to postgres;
revoke execute on function public.employment_authority_version_guard() from public;
commit;

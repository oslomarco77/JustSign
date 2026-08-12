// True-overlap PostgreSQL harness; excluded from Vitest discovery.
import { spawn, spawnSync } from 'node:child_process';

const container=process.env.SD408_DB_CONTAINER;
if(!container||!/^sd408a2-[a-z0-9-]+$/.test(container))throw new Error('invalid disposable SD408_DB_CONTAINER');
const args=['exec','-i',container,'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres','-d','sd408_clean'];
function psql(sql){const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.stdin.end(sql);
  return new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr})));}
function sync(sql){return spawnSync('docker',args,{input:sql,encoding:'utf8'});}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn,label){for(let i=0;i<200;i++){if(fn())return;await sleep(50);}throw new Error(`timeout: ${label}`);}

const setup=sync(`
insert into public.emp_contracts(id,updated_at) values('93000000-0000-4000-8000-000000000001',clock_timestamp());
insert into public.employment_authority_contracts(id,legacy_contract_id)
values('93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001');
do $$declare source jsonb;doc jsonb;vid uuid;vn integer;source_time timestamptz;begin
 select updated_at into source_time from public.emp_contracts
  where id='93000000-0000-4000-8000-000000000001';
 for vn in 1..2 loop
  vid:=case vn when 1 then '93000000-0000-4000-8000-000000000003'::uuid else '93000000-0000-4000-8000-000000000008'::uuid end;
  source:=jsonb_build_object('parties',jsonb_build_array(jsonb_build_object('role','employer','name','A'),
    jsonb_build_object('role','employee','name','B')),'version_content',vn);
  doc:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
    'employment_id','93000000-0000-4000-8000-000000000002','legacy_contract_id','93000000-0000-4000-8000-000000000001',
    'version_id',vid,'version_number',vn))||source;
  insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,source_updated_at,
    source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,canonical_document,document_hash,lifecycle_status,issued_at)
  values(vid,'93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001',vn,source_time,
    extensions.digest(convert_to(source::text,'UTF8'),'sha256'),source::text,'signdee.employment.document.v1',
    case when vn=1 then doc::text else null end,case when vn=1 then doc else null end,
    case when vn=1 then extensions.digest(convert_to(doc::text,'UTF8'),'sha256') else null end,
    case when vn=1 then 'issued' else 'draft' end,case when vn=1 then clock_timestamp() else null end);
 end loop;
end$$;
set role service_role;
select public.employment_authority_authorize_signers(
 '93000000-0000-4000-8000-000000000003',jsonb_build_array(
 jsonb_build_object('id','93000000-0000-4000-8000-000000000004','capability_id','93000000-0000-4000-8000-000000000005','role','employer','capability_digest',repeat('a1',32),'expires_at',clock_timestamp()+interval '3 days'),
 jsonb_build_object('id','93000000-0000-4000-8000-000000000006','capability_id','93000000-0000-4000-8000-000000000007','role','employee','capability_digest',repeat('a2',32),'expires_at',clock_timestamp()+interval '3 days')));
`);
if(setup.status!==0)throw new Error(setup.stderr);

async function overlap(versionId,calls){
  const blocker=psql(`begin;select id from public.employment_authority_versions where id='${versionId}' for update;select pg_sleep(3);commit;`);
  await sleep(300);
  const sessions=calls.map(([cap,sig])=>psql(`set role service_role;select public.employment_authority_sign_version('${cap}','${sig}','signdee.employment.signing-consent.v1');`));
  let waiters=0;await waitFor(()=>{const q=sync("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_sign_version%' and query not like '%pg_stat_activity%';");waiters=Number(q.stdout.trim());return waiters>=calls.length;},'overlapping signing sessions');
  await blocker;return {waiters,results:await Promise.all(sessions)};
}

const duplicate=await overlap('93000000-0000-4000-8000-000000000003',[["a1".repeat(32),"11".repeat(32)],["a1".repeat(32),"11".repeat(32)]]);
if(duplicate.results.some(x=>x.code!==0))throw new Error(JSON.stringify(duplicate.results));
const created=duplicate.results.filter(x=>x.stdout.includes('"created": true')).length;
const recovered=duplicate.results.filter(x=>x.stdout.includes('"created": false')).length;
if(created!==1||recovered!==1)throw new Error(`duplicate outcome ${created}/${recovered}`);

const issueSql=`create temporary table employment_issue_fixture as
with v as (
 select * from public.employment_authority_versions where id='93000000-0000-4000-8000-000000000008'
), d as (
 select v.*,jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
  'employment_id',v.employment_id,'legacy_contract_id',v.legacy_contract_id,'version_id',v.id,'version_number',v.version_number))
  ||v.source_canonical_payload::jsonb as doc from v
)
select employment_id,id,source_updated_at,canonical_schema,doc::text as payload,doc,
 encode(extensions.digest(convert_to(doc::text,'UTF8'),'sha256'),'hex') as hash from d;
grant select on employment_issue_fixture to service_role;
set role service_role;
select public.employment_authority_issue_version(employment_id,id,source_updated_at,canonical_schema,
 payload,doc,hash) from employment_issue_fixture;`;

const versionBlocker=psql(`begin;
select id from public.employment_authority_versions
 where id='93000000-0000-4000-8000-000000000008' for update;
select pg_sleep(3);commit;`);
await sleep(300);
const issueV2=psql(issueSql);
await waitFor(()=>{const q=sync("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_issue_version%' and query not like '%pg_stat_activity%';");return Number(q.stdout.trim())>=1;},'V2 issuance holds authority and waits on version');
const firstTimeV1=psql(`set role service_role;select public.employment_authority_sign_version(
 '${"a2".repeat(32)}','${"12".repeat(32)}','signdee.employment.signing-consent.v1');`);
await waitFor(()=>{const q=sync("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_sign_version%' and query not like '%pg_stat_activity%';");return Number(q.stdout.trim())>=1;},'V1 signing waits on Employment authority');
await versionBlocker;
const [issueV2Result,firstTimeV1Result]=await Promise.all([issueV2,firstTimeV1]);
if(issueV2Result.code!==0||!issueV2Result.stdout.includes('"created": true'))
  throw new Error(`serialized V2 issuance failed: ${JSON.stringify(issueV2Result)}`);
if(firstTimeV1Result.code===0||!firstTimeV1Result.stderr.includes('employment_signing_not_authorized'))
  throw new Error(`stale first-time V1 signing was not rejected: ${JSON.stringify(firstTimeV1Result)}`);

const issueState=sync(`select jsonb_build_object(
 'v1_signer_status',(select signing_status from public.employment_authority_signers where id='93000000-0000-4000-8000-000000000006'),
 'v2_status',(select lifecycle_status from public.employment_authority_versions where id='93000000-0000-4000-8000-000000000008'),
 'v2_issued_at',(select issued_at from public.employment_authority_versions where id='93000000-0000-4000-8000-000000000008'));`);
if(issueState.status!==0)throw new Error(issueState.stderr);
const serialized=JSON.parse(issueState.stdout.trim());
if(serialized.v2_status!=='issued'||serialized.v1_signer_status!=='pending'||!serialized.v2_issued_at)
  throw new Error(issueState.stdout);

const recoveredAfterV2=sync(`set role service_role;select public.employment_authority_sign_version(
 '${"a1".repeat(32)}','${"11".repeat(32)}','signdee.employment.signing-consent.v1');`);
if(recoveredAfterV2.status!==0||!recoveredAfterV2.stdout.includes('"created": false'))
  throw new Error(`idempotent V1 recovery failed after V2: ${recoveredAfterV2.stderr}`);

const authorizeV2=sync(`set role service_role;
select public.employment_authority_authorize_signers('93000000-0000-4000-8000-000000000008',jsonb_build_array(
 jsonb_build_object('id','93000000-0000-4000-8000-000000000009','capability_id','93000000-0000-4000-8000-000000000010','role','employer','capability_digest',repeat('b1',32),'expires_at',clock_timestamp()+interval '3 days'),
 jsonb_build_object('id','93000000-0000-4000-8000-000000000011','capability_id','93000000-0000-4000-8000-000000000012','role','employee','capability_digest',repeat('b2',32),'expires_at',clock_timestamp()+interval '3 days')));`);
if(authorizeV2.status!==0)throw new Error(authorizeV2.stderr);

const independent=await overlap('93000000-0000-4000-8000-000000000008',[["b1".repeat(32),"21".repeat(32)],["b2".repeat(32),"22".repeat(32)]]);
if(independent.results.some(x=>x.code!==0)||independent.results.filter(x=>x.stdout.includes('"created": true')).length!==2)
  throw new Error(JSON.stringify(independent.results));

const check=sync(`select jsonb_build_object(
 'v1_signed',(select count(*) from public.employment_authority_signers where version_id='93000000-0000-4000-8000-000000000003' and signing_status='signed'),
 'v1_sign_audit',(select count(*) from public.employment_authority_signing_audit_events where version_id='93000000-0000-4000-8000-000000000003' and event_type='signer.signed'),
 'v2_signed',(select count(*) from public.employment_authority_signers where version_id='93000000-0000-4000-8000-000000000008' and signing_status='signed'),
 'v2_sign_audit',(select count(*) from public.employment_authority_signing_audit_events where version_id='93000000-0000-4000-8000-000000000008' and event_type='signer.signed'));`);
if(check.status!==0)throw new Error(check.stderr);
const state=JSON.parse(check.stdout.trim());
if(state.v1_signed!==1||state.v1_sign_audit!==1||state.v2_signed!==2||state.v2_sign_audit!==2)throw new Error(check.stdout);
console.log(JSON.stringify({duplicate_waiters:duplicate.waiters,duplicate_created:created,duplicate_recovered:recovered,
  sign_issue_overlap:'V2_issued_then_V1_rejected',idempotent_v1_after_v2:'recovered',older_version_after_v2:'rejected',
  independent_waiters:independent.waiters,...state}));

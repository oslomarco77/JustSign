// Real PostgreSQL overlap harness; excluded from Vitest discovery.
import {spawn,spawnSync} from 'node:child_process';
const container=process.env.SD408_A4_DB_CONTAINER;
if(!container||!/^sd408a4-[a-z0-9-]+$/.test(container))throw new Error('invalid disposable SD408_A4_DB_CONTAINER');
const args=['exec','-i',container,'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres'];
function psql(sql){const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.stdin.end(sql);
  return new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr})));}
function sync(sql){return spawnSync('docker',args,{input:sql,encoding:'utf8'});}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(sql,label,count=1){for(let i=0;i<200;i++){const r=sync(sql);
  if(r.status===0&&Number(r.stdout.trim())>=count)return Number(r.stdout.trim());await sleep(50);}
  throw new Error(`timeout: ${label}`);}

function fixture(prefix,capA,capB){const employment=`${prefix}0000-0000-4000-8000-000000000001`;
  const legacy=`${prefix}0000-0000-4000-8000-000000000002`;
  const version=`${prefix}0000-0000-4000-8000-000000000003`;
  return{employment,legacy,version,sql:`
insert into public.emp_contracts(id,updated_at) values('${legacy}',clock_timestamp());
insert into public.employment_authority_contracts(id,legacy_contract_id) values('${employment}','${legacy}');
do $$declare s jsonb;d jsonb;begin s:=jsonb_build_object('content','concurrency','parties',jsonb_build_array(
 jsonb_build_object('role','employer','name','A'),jsonb_build_object('role','employee','name','B')));
 d:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object(
 'employment_id','${employment}','legacy_contract_id','${legacy}','version_id','${version}','version_number',1))||s;
 insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,
 source_updated_at,source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,
 canonical_document,document_hash,lifecycle_status,issued_at) values('${version}','${employment}','${legacy}',1,
 clock_timestamp(),extensions.digest(convert_to(s::text,'UTF8'),'sha256'),s::text,
 'signdee.employment.document.v1',d::text,d,extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'issued',clock_timestamp());end$$;
set role service_role;
select public.employment_authority_authorize_signers('${version}',jsonb_build_array(
 jsonb_build_object('id',gen_random_uuid(),'capability_id',gen_random_uuid(),'role','employer','capability_digest',repeat('${capA}',32),'expires_at',clock_timestamp()+interval '3 days'),
 jsonb_build_object('id',gen_random_uuid(),'capability_id',gen_random_uuid(),'role','employee','capability_digest',repeat('${capB}',32),'expires_at',clock_timestamp()+interval '3 days')));
select public.employment_authority_sign_version(repeat('${capA}',32),repeat('71',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version(repeat('${capB}',32),repeat('72',32),'signdee.employment.signing-consent.v1');
select public.employment_authority_issue_signed_evidence('${employment}','${version}');reset role;`};}
const same=fixture('a4a1','a1','a2');const different=fixture('a4b1','b1','b2');
const setup=sync(same.sql+different.sql);if(setup.status!==0)throw new Error(setup.stderr);

async function reservationRace(source,workspaceA,workspaceB){
  const blocker=psql(`begin;select id from public.employment_authority_contracts where id='${source.employment}' for update;select pg_sleep(3);commit;`);
  await sleep(300);const call=workspace=>psql(`set role service_role;select public.employment_authority_reserve_workspace_binding('${source.employment}','${source.version}','${workspace}','workspace-adapter:v1');`);
  const calls=[call(workspaceA),call(workspaceB)];const waiters=await waitFor(
    "select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_reserve_workspace_binding%' and query not like '%pg_stat_activity%';",
    'reservation waiters',2);await blocker;const results=await Promise.all(calls);
  if(results.some(x=>x.code!==0))throw new Error(JSON.stringify(results));return{waiters,results};}

const workspaceSame='a4a10000-0000-4000-8000-000000000009';
const sameRace=await reservationRace(same,workspaceSame,workspaceSame);
const sameCreated=sameRace.results.filter(x=>x.stdout.includes('"created": true')).length;
const sameRecovered=sameRace.results.filter(x=>x.stdout.includes('"created": false')).length;
if(sameCreated!==1||sameRecovered!==1)throw new Error(`same reservation ${sameCreated}/${sameRecovered}`);

const differentRace=await reservationRace(different,'a4b10000-0000-4000-8000-000000000009',
  'a4b10000-0000-4000-8000-000000000010');
const reserved=differentRace.results.filter(x=>x.stdout.includes('"outcome": "reserved"')).length;
const conflicts=differentRace.results.filter(x=>x.stdout.includes('"outcome": "conflict"')).length;
if(reserved!==1||conflicts!==1)throw new Error(`different reservation ${reserved}/${conflicts}`);

const binding=sync(`select id||'|'||workspace_id from public.employment_workspace_binding_authorities where employment_id='${same.employment}'`);
if(binding.status!==0)throw new Error(binding.stderr);const [bindingId,workspaceId]=binding.stdout.trim().split('|');
const ackBlocker=psql(`begin;select id from public.employment_workspace_binding_authorities where id='${bindingId}' for update;select pg_sleep(3);commit;`);
await sleep(300);const resultId='a4a10000-0000-4000-8000-000000000011';
const acknowledgements=[1,2].map(()=>psql(`set role service_role;select public.employment_authority_confirm_workspace_acceptance('${bindingId}','${workspaceId}','${resultId}');`));
const ackWaiters=await waitFor("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_confirm_workspace_acceptance%' and query not like '%pg_stat_activity%';",'ack waiters',2);
await ackBlocker;const ackResults=await Promise.all(acknowledgements);
if(ackResults.some(x=>x.code!==0))throw new Error(JSON.stringify(ackResults));
const ackCreated=ackResults.filter(x=>x.stdout.includes('"created": true')).length;
const ackRecovered=ackResults.filter(x=>x.stdout.includes('"created": false')).length;
if(ackCreated!==1||ackRecovered!==1)throw new Error(`ack ${ackCreated}/${ackRecovered}`);

const final=sync(`select concat_ws('|',(select count(*) from public.employment_workspace_binding_authorities),
 (select count(*) from public.employment_workspace_binding_authorities where binding_status='bound'),
 (select count(*) from public.employment_workspace_binding_audit_events where event_type='workspace_binding.reserved'),
 (select count(*) from public.employment_workspace_binding_audit_events where event_type='workspace_binding.idempotent_replay'),
 (select count(*) from public.employment_workspace_binding_audit_events where event_type='workspace_binding.conflict'),
 (select count(*) from public.employment_workspace_binding_audit_events where event_type='workspace_binding.bound'),
 (select count(*) from public.employment_workspace_binding_audit_events where event_type='workspace_binding.bound_replay'))`);
if(final.status!==0||final.stdout.trim()!=='2|1|2|1|1|1|1')throw new Error(final.stdout+final.stderr);
console.log(JSON.stringify({same_waiters:sameRace.waiters,same_created:sameCreated,same_recovered:sameRecovered,
  different_waiters:differentRace.waiters,different_reserved:reserved,different_conflict:conflicts,
  acknowledgement_waiters:ackWaiters,ack_created:ackCreated,ack_recovered:ackRecovered,
  final_state:final.stdout.trim()}));

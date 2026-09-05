// Real PostgreSQL overlap harness; excluded from Vitest discovery.
import { spawn, spawnSync } from 'node:child_process';

const container=process.env.SD408_A3_DB_CONTAINER;
if(!container||!/^sd408a3-[a-z0-9-]+$/.test(container))throw new Error('invalid disposable SD408_A3_DB_CONTAINER');
const args=['exec','-i',container,'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U','postgres'];
function psql(sql){const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.stdin.end(sql);
  return new Promise(resolve=>child.on('close',code=>resolve({code,stdout,stderr})));}
function sync(sql){return spawnSync('docker',args,{input:sql,encoding:'utf8'});}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(sql,label,count=1){for(let i=0;i<200;i++){const q=sync(sql);if(q.status===0&&Number(q.stdout.trim())>=count)return Number(q.stdout.trim());await sleep(50);}throw new Error(`timeout: ${label}`);}

function createEmployment(prefix,content){const employment=`${prefix}0000-0000-4000-8000-000000000001`;
  const legacy=`${prefix}0000-0000-4000-8000-000000000002`;const version=`${prefix}0000-0000-4000-8000-000000000003`;
  const employer=`${prefix}0000-0000-4000-8000-000000000004`;const employee=`${prefix}0000-0000-4000-8000-000000000006`;
  return {employment,legacy,version,employer,employee,sql:`
insert into public.emp_contracts(id,updated_at) values('${legacy}',clock_timestamp());
insert into public.employment_authority_contracts(id,legacy_contract_id) values('${employment}','${legacy}');
do $$declare source jsonb;doc jsonb;source_time timestamptz;begin
 select updated_at into source_time from public.emp_contracts where id='${legacy}';
 source:=jsonb_build_object('parties',jsonb_build_array(jsonb_build_object('role','employer','name','A'),jsonb_build_object('role','employee','name','B')),'version_content','${content}');
 doc:=jsonb_build_object('canonical_schema','signdee.employment.document.v1','authority',jsonb_build_object('employment_id','${employment}','legacy_contract_id','${legacy}','version_id','${version}','version_number',1))||source;
 insert into public.employment_authority_versions(id,employment_id,legacy_contract_id,version_number,source_updated_at,source_content_digest,source_canonical_payload,canonical_schema,canonical_payload,canonical_document,document_hash,lifecycle_status,issued_at)
 values('${version}','${employment}','${legacy}',1,source_time,extensions.digest(convert_to(source::text,'UTF8'),'sha256'),source::text,'signdee.employment.document.v1',doc::text,doc,extensions.digest(convert_to(doc::text,'UTF8'),'sha256'),'issued',clock_timestamp());
end$$;
set role service_role;
select public.employment_authority_authorize_signers('${version}',jsonb_build_array(
 jsonb_build_object('id','${employer}','capability_id','${prefix}0000-0000-4000-8000-000000000005','role','employer','capability_digest',repeat('${content}',32),'expires_at',clock_timestamp()+interval '3 days'),
 jsonb_build_object('id','${employee}','capability_id','${prefix}0000-0000-4000-8000-000000000007','role','employee','capability_digest',repeat('${content[0]}2',32),'expires_at',clock_timestamp()+interval '3 days')));
reset role;
`};}

const serial=createEmployment('a3a1','a1');
const duplicate=createEmployment('a3b1','b1');
const setup=sync(serial.sql+duplicate.sql+`
set role service_role;
select public.employment_authority_sign_version('${'a1'.repeat(32)}','${'31'.repeat(32)}','signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version('${'b1'.repeat(32)}','${'41'.repeat(32)}','signdee.employment.signing-consent.v1');
select public.employment_authority_sign_version('${'b2'.repeat(32)}','${'42'.repeat(32)}','signdee.employment.signing-consent.v1');`);
if(setup.status!==0)throw new Error(setup.stderr);

// Evidence holds the Employment lock while waiting on the pending signer row.
// The final signer must therefore wait, evidence rejects the incomplete snapshot,
// and a retry after signing succeeds.
const signerBlocker=psql(`begin;select id from public.employment_authority_signers where id='${serial.employee}' for update;select pg_sleep(3);commit;`);
await sleep(300);
const evidenceFirst=psql(`set role service_role;select public.employment_authority_issue_signed_evidence('${serial.employment}','${serial.version}');`);
await waitFor("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_issue_signed_evidence%' and query not like '%pg_stat_activity%';",'evidence waits on signer');
const finalSigner=psql(`set role service_role;select public.employment_authority_sign_version('${'a2'.repeat(32)}','${'32'.repeat(32)}','signdee.employment.signing-consent.v1');`);
await waitFor("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_sign_version%' and query not like '%pg_stat_activity%';",'final signer waits on Employment authority');
await signerBlocker;
const [earlyEvidence,signed]=await Promise.all([evidenceFirst,finalSigner]);
if(earlyEvidence.code===0||!earlyEvidence.stderr.includes('employment_signed_evidence_not_eligible'))throw new Error(`incomplete evidence did not reject: ${JSON.stringify(earlyEvidence)}`);
if(signed.code!==0||!signed.stdout.includes('"created": true'))throw new Error(`final signer failed: ${JSON.stringify(signed)}`);
const retry=sync(`set role service_role;select public.employment_authority_issue_signed_evidence('${serial.employment}','${serial.version}');`);
if(retry.status!==0||!retry.stdout.includes('"created": true'))throw new Error(`post-sign evidence retry failed: ${retry.stderr}`);

// Two eligible issuers overlap behind the same aggregate row lock. Exactly one
// materializes the authority; the other recovers it.
const authorityBlocker=psql(`begin;select id from public.employment_authority_contracts where id='${duplicate.employment}' for update;select pg_sleep(3);commit;`);
await sleep(300);
const issuers=[1,2].map(()=>psql(`set role service_role;select public.employment_authority_issue_signed_evidence('${duplicate.employment}','${duplicate.version}');`));
const duplicateWaiters=await waitFor("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%employment_authority_issue_signed_evidence%' and query not like '%pg_stat_activity%';",'duplicate evidence issuers',2);
await authorityBlocker;
const outcomes=await Promise.all(issuers);
if(outcomes.some(x=>x.code!==0))throw new Error(JSON.stringify(outcomes));
const created=outcomes.filter(x=>x.stdout.includes('"created": true')).length;
const recovered=outcomes.filter(x=>x.stdout.includes('"created": false')).length;
if(created!==1||recovered!==1)throw new Error(`duplicate outcome ${created}/${recovered}`);

const check=sync(`select jsonb_build_object(
 'serial_signed',(select count(*) from public.employment_authority_signers where version_id='${serial.version}' and signing_status='signed'),
 'serial_evidence',(select count(*) from public.employment_signed_evidence_authorities where version_id='${serial.version}'),
 'duplicate_evidence',(select count(*) from public.employment_signed_evidence_authorities where version_id='${duplicate.version}'))`);
if(check.status!==0)throw new Error(check.stderr);const state=JSON.parse(check.stdout.trim());
if(state.serial_signed!==2||state.serial_evidence!==1||state.duplicate_evidence!==1)throw new Error(check.stdout);
console.log(JSON.stringify({evidence_first:'rejected_then_retry_created',final_signer:'created',duplicate_waiters:duplicateWaiters,duplicate_created:created,duplicate_recovered:recovered,...state}));

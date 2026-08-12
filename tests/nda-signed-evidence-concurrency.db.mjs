// Standalone local database harness; intentionally excluded from Vitest discovery.
import { spawn, spawnSync } from "node:child_process";

const container = process.env.SD407_DB_CONTAINER;
if (!container || !/^sd407a2c-[a-z0-9-]+$/.test(container)) {
  throw new Error("SD407_DB_CONTAINER must identify the disposable SD-407A.2C container");
}
const args = ["exec","-i","-e","PGPASSWORD=sd407_local_only",container,
  "psql","-X","-A","-t","-v","ON_ERROR_STOP=1","-U","postgres","-d","postgres"];
function psql(sql) {
  const child=spawn("docker",args,{stdio:["pipe","pipe","pipe"]});
  let stdout="",stderr="";
  child.stdout.on("data",c=>{stdout+=c;}); child.stderr.on("data",c=>{stderr+=c;});
  child.stdin.end(sql);
  return new Promise(resolve=>child.on("close",code=>resolve({code,stdout,stderr})));
}
function sync(sql){return spawnSync("docker",args,{input:sql,encoding:"utf8"});}
const nda="89000000-0000-4000-8000-000000000001";
const version="89000000-0000-4000-8000-000000000002";
const a="89000000-0000-4000-8000-000000000003";
const b="89000000-0000-4000-8000-000000000004";
const setup=sync(`
set role service_role;
do $$ declare d jsonb; begin
 d:=jsonb_build_object('canonical_schema','signdee.nda.document.v1','nda_id','${nda}',
 'version_id','${version}','version_number',1,'parties',jsonb_build_array(
 jsonb_build_object('signer_id','${a}','party_ref','${a}','role','discloser'),
 jsonb_build_object('signer_id','${b}','party_ref','${b}','role','recipient')),
 'title','Evidence concurrency test','clauses',jsonb_build_array('one','two'));
 perform public.nda_authority_create_initial_version('${nda}','${version}',
 'signdee.nda.document.v1',d::text,d,
 encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex'),jsonb_build_array(
 jsonb_build_object('id','${a}','party_ref','${a}','role','discloser','capability_digest',repeat('91',32),'expires_at','2099-01-01Z'),
 jsonb_build_object('id','${b}','party_ref','${b}','role','recipient','capability_digest',repeat('92',32),'expires_at','2099-01-01Z')));
end $$;
select public.nda_authority_sign_version('${nda}','${version}','${a}',repeat('91',32),'signdee.nda.signing-consent.v1');
select public.nda_authority_sign_version('${nda}','${version}','${b}',repeat('92',32),'signdee.nda.signing-consent.v1');
`);
if(setup.status!==0) throw new Error(setup.stderr);

const blocker=psql(`begin; select id from public.nda_authority_versions where id='${version}' for update;
select pg_sleep(8); commit;`);
await new Promise(resolve=>setTimeout(resolve,500));
const sql=`set role service_role; select public.nda_authority_issue_signed_evidence('${nda}','${version}');`;
const one=psql(sql),two=psql(sql);
const [blocked,r1,r2]=await Promise.all([blocker,one,two]);
if(blocked.code!==0||r1.code!==0||r2.code!==0) throw new Error(JSON.stringify({blocked,r1,r2}));
const created=[r1,r2].filter(r=>r.stdout.includes('"created": true')).length;
const replay=[r1,r2].filter(r=>r.stdout.includes('"created": false')).length;
const refs=[r1,r2].map(r=>JSON.parse(r.stdout.trim().split("\n").at(-1)).signed_document_reference);
const verify=sync(`select concat_ws('|',
 (select count(*) from public.nda_signed_evidence_authorities where nda_id='${nda}'),
 (select count(*) from public.nda_signed_evidence_audit_events where nda_id='${nda}'),
 (select count(distinct signed_document_reference) from public.nda_signed_evidence_authorities where nda_id='${nda}'))`);
const state=verify.stdout.trim();
if(created!==1||replay!==1||new Set(refs).size!==1||state!=="1|1|1") {
  throw new Error(`concurrency invariant failed: ${JSON.stringify({created,replay,refs,state})}`);
}
process.stdout.write(JSON.stringify({created,replay,same_reference:true,final_state:state})+"\n");

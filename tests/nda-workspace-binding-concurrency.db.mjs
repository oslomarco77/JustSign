// Standalone local-database harness; intentionally excluded from Vitest discovery.
import { spawn, spawnSync } from "node:child_process";

const container = process.env.SD407B_DB_CONTAINER;
if (!container || !/^sd407b1-[a-z0-9-]+$/.test(container)) {
  throw new Error("SD407B_DB_CONTAINER must identify the disposable SD-407B.1 container");
}

const args = [
  "exec", "-i", "-e", "PGPASSWORD=sd407_local_only", container,
  "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
];

function psql(sql) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

const psqlSync = (sql) => spawnSync("docker", args, { input: sql, encoding: "utf8" });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setupCompleted(prefix) {
  const nda = `${prefix}0000000-0000-4000-8000-000000000001`;
  const version = `${prefix}0000000-0000-4000-8000-000000000002`;
  const signerA = `${prefix}0000000-0000-4000-8000-000000000003`;
  const partyA = `${prefix}0000000-0000-4000-8000-000000000004`;
  const signerB = `${prefix}0000000-0000-4000-8000-000000000005`;
  const partyB = `${prefix}0000000-0000-4000-8000-000000000006`;
  const digestA = (prefix === "8" ? "b" : "d").repeat(64);
  const digestB = (prefix === "8" ? "c" : "e").repeat(64);
  const result = psqlSync(`
do $$ declare d jsonb; begin
  d := jsonb_build_object(
    'canonical_schema','signdee.nda.document.v1','nda_id','${nda}',
    'version_id','${version}','version_number',1,
    'parties',jsonb_build_array(
      jsonb_build_object('signer_id','${signerA}','party_ref','${partyA}','role','discloser'),
      jsonb_build_object('signer_id','${signerB}','party_ref','${partyB}','role','recipient')),
    'title','Workspace binding concurrency test','clauses',jsonb_build_array('one','two'));
  perform public.nda_authority_create_initial_version(
    '${nda}','${version}','signdee.nda.document.v1',d::text,d,
    encode(extensions.digest(convert_to(d::text,'UTF8'),'sha256'),'hex'),
    jsonb_build_array(
      jsonb_build_object('id','${signerA}','party_ref','${partyA}','role','discloser',
        'capability_digest','${digestA}','expires_at','2099-01-01T00:00:00Z'),
      jsonb_build_object('id','${signerB}','party_ref','${partyB}','role','recipient',
        'capability_digest','${digestB}','expires_at','2099-01-01T00:00:00Z')));
  perform public.nda_authority_sign_version(
    '${nda}','${version}','${signerA}','${digestA}','signdee.nda.signing-consent.v1');
  perform public.nda_authority_sign_version(
    '${nda}','${version}','${signerB}','${digestB}','signdee.nda.signing-consent.v1');
end $$;
`);
  if (result.status !== 0) throw new Error(`fixture failed: ${result.stderr}`);
  return { nda, version };
}

async function race(authority, workspaceOne, workspaceTwo, markerName) {
  const marker = `/tmp/${markerName}`;
  const blocker = psql(`
begin;
select id from public.nda_authority_contracts where id='${authority.nda}' for update;
\\! touch ${marker}
select pg_sleep(12);
commit;
`);
  await waitFor(
    () => spawnSync("docker", ["exec", container, "test", "-f", marker]).status === 0,
    `${markerName} blocker`,
  );
  const call = (workspace) => psql(`
set role service_role;
select public.nda_authority_reserve_workspace_binding(
  '${authority.nda}','${authority.version}','${workspace}','workspace-adapter:v1');
`);
  const sessionOne = call(workspaceOne);
  const sessionTwo = call(workspaceTwo);
  let waiters = 0;
  await waitFor(() => {
    const observed = psqlSync(`
select count(*) from pg_stat_activity
where wait_event_type='Lock' and query like '%nda_authority_reserve_workspace_binding%'
  and query not like '%pg_stat_activity%';
`);
    waiters = Number(observed.stdout.trim());
    return observed.status === 0 && waiters >= 2;
  }, `${markerName} concurrent waiters`);
  const [blockerResult, first, second] = await Promise.all([blocker, sessionOne, sessionTwo]);
  if (blockerResult.code !== 0) throw new Error(`blocker failed: ${blockerResult.stderr}`);
  const sessions = [first, second].map((result, index) => {
    if (result.code !== 0) throw new Error(`session ${index + 1} failed: ${result.stderr}`);
    return { session: index + 1, response: JSON.parse(result.stdout.trim()) };
  });
  return { waiters, sessions };
}

const same = setupCompleted("8");
const sameWorkspace = "80000000-0000-4000-8000-000000000007";
const sameRace = await race(same, sameWorkspace, sameWorkspace, "sd407b1-same-ready");
const sameCreated = sameRace.sessions.filter((x) => x.response.created === true).length;
const sameReplay = sameRace.sessions.filter((x) => x.response.created === false).length;
if (sameCreated !== 1 || sameReplay !== 1) throw new Error("same-target race was not idempotent");
const sameState = psqlSync(`
select concat_ws('|',
  (select count(*) from public.nda_workspace_binding_authorities where nda_id='${same.nda}'),
  (select count(*) from public.nda_workspace_binding_audit_events
    where nda_id='${same.nda}' and event_type='workspace_binding.reserved'),
  (select count(*) from public.nda_workspace_binding_audit_events
    where nda_id='${same.nda}' and event_type='workspace_binding.idempotent_replay'),
  (select count(*) from public.nda_workspace_binding_audit_events
    where nda_id='${same.nda}' and event_type='workspace_binding.conflict'),
  (select count(*) from public.nda_authority_audit_events
    where nda_id='${same.nda}' and event_type='version.completed'),
  (select binding_status from public.nda_workspace_binding_authorities where nda_id='${same.nda}')
);
`);
if (sameState.status !== 0 || sameState.stdout.trim() !== "1|1|1|0|1|reserved") {
  throw new Error(`invalid same-target state: ${sameState.stdout} ${sameState.stderr}`);
}

const different = setupCompleted("9");
const workspaceA = "90000000-0000-4000-8000-000000000007";
const workspaceB = "90000000-0000-4000-8000-000000000008";
const differentRace = await race(different, workspaceA, workspaceB, "sd407b1-different-ready");
const accepted = differentRace.sessions.filter((x) => x.response.outcome === "reserved").length;
const conflicted = differentRace.sessions.filter((x) => x.response.outcome === "conflict").length;
if (accepted !== 1 || conflicted !== 1) throw new Error("different-target race did not conflict exactly once");
const differentState = psqlSync(`
select concat_ws('|',
  (select count(*) from public.nda_workspace_binding_authorities where nda_id='${different.nda}'),
  (select count(*) from public.nda_workspace_binding_audit_events
    where nda_id='${different.nda}' and event_type='workspace_binding.reserved'),
  (select count(*) from public.nda_workspace_binding_audit_events
    where nda_id='${different.nda}' and event_type='workspace_binding.idempotent_replay'),
  (select count(*) from public.nda_workspace_binding_audit_events
    where nda_id='${different.nda}' and event_type='workspace_binding.conflict'),
  (select count(*) from public.nda_authority_audit_events
    where nda_id='${different.nda}' and event_type='version.completed'),
  (select binding_status from public.nda_workspace_binding_authorities where nda_id='${different.nda}')
);
`);
if (differentState.status !== 0 || differentState.stdout.trim() !== "1|1|0|1|1|reserved") {
  throw new Error(`invalid different-target state: ${differentState.stdout} ${differentState.stderr}`);
}

process.stdout.write(`${JSON.stringify({
  same_target: {
    observed_waiting_sessions: sameRace.waiters,
    session_results: sameRace.sessions.map((x) => ({
      session: x.session, result: x.response.created ? "created" : "idempotent_replay",
    })),
    final_state: sameState.stdout.trim(),
  },
  different_target: {
    observed_waiting_sessions: differentRace.waiters,
    session_results: differentRace.sessions.map((x) => ({
      session: x.session, result: x.response.outcome,
    })),
    final_state: differentState.stdout.trim(),
  },
})}\n`);

// Standalone local-database harness; intentionally excluded from Vitest discovery.
import { spawn, spawnSync } from "node:child_process";

const container = process.env.SD407_DB_CONTAINER;
if (!container || !/^sd407a2b-[a-z0-9-]+$/.test(container)) {
  throw new Error("SD407_DB_CONTAINER must identify the disposable SD-407A.2B container");
}

const connectionArgs = [
  "exec", "-i", "-e", "PGPASSWORD=sd407_local_only", container,
  "psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
];

function psql(sql) {
  const child = spawn("docker", connectionArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function psqlSync(sql) {
  return spawnSync("docker", connectionArgs, { input: sql, encoding: "utf8" });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const ndaId = "60000000-0000-4000-8000-000000000001";
const versionId = "60000000-0000-4000-8000-000000000002";
const signerId = "60000000-0000-4000-8000-000000000003";
const capabilityDigest = "de".repeat(32);
const marker = "/tmp/sd407a2b-concurrency-lock-ready";

const setup = psqlSync(`
do $$
declare
  d jsonb;
begin
  d := jsonb_build_object(
    'canonical_schema', 'signdee.nda.document.v1',
    'nda_id', '${ndaId}', 'version_id', '${versionId}', 'version_number', 1,
    'parties', jsonb_build_array(
      jsonb_build_object(
        'signer_id', '${signerId}',
        'party_ref', '60000000-0000-4000-8000-000000000004', 'role', 'discloser'),
      jsonb_build_object(
        'signer_id', '60000000-0000-4000-8000-000000000005',
        'party_ref', '60000000-0000-4000-8000-000000000006', 'role', 'recipient')
    ),
    'title', 'Concurrent signing test', 'clauses', jsonb_build_array('one','two')
  );
  perform public.nda_authority_create_initial_version(
    '${ndaId}', '${versionId}', 'signdee.nda.document.v1', d::text, d,
    encode(extensions.digest(convert_to(d::text, 'UTF8'), 'sha256'), 'hex'),
    jsonb_build_array(
      jsonb_build_object(
        'id', '${signerId}', 'party_ref', '60000000-0000-4000-8000-000000000004',
        'role', 'discloser', 'capability_digest', '${capabilityDigest}',
        'expires_at', '2099-01-01T00:00:00Z'),
      jsonb_build_object(
        'id', '60000000-0000-4000-8000-000000000005',
        'party_ref', '60000000-0000-4000-8000-000000000006',
        'role', 'recipient', 'capability_digest', repeat('ef', 32),
        'expires_at', '2099-01-01T00:00:00Z')
    )
  );
end $$;
`);
if (setup.status !== 0) throw new Error(`concurrency fixture failed: ${setup.stderr}`);

const blocker = psql(`
begin;
select id from public.nda_authority_versions
where nda_id = '${ndaId}' and id = '${versionId}' for update;
\\! touch ${marker}
select pg_sleep(12);
commit;
`);

await waitFor(() => spawnSync("docker", ["exec", container, "test", "-f", marker]).status === 0, "blocker row lock");

const signingSql = `
set role service_role;
select public.nda_authority_sign_version(
  '${ndaId}', '${versionId}', '${signerId}', '${capabilityDigest}',
  'signdee.nda.signing-consent.v1');
`;
const sessionOne = psql(signingSql);
const sessionTwo = psql(signingSql);

let observedWaiters = 0;
await waitFor(() => {
  const result = psqlSync(`
    select count(*) from pg_stat_activity
    where wait_event_type = 'Lock'
      and query like '%nda_authority_sign_version%'
      and query not like '%pg_stat_activity%';
  `);
  observedWaiters = Number(result.stdout.trim().split(/\s+/).at(-1));
  return result.status === 0 && observedWaiters >= 2;
}, "two concurrently blocked signing sessions");

const [blockerResult, first, second] = await Promise.all([blocker, sessionOne, sessionTwo]);
if (blockerResult.code !== 0) throw new Error(`blocker failed: ${blockerResult.stderr}`);

const sessions = [first, second];
const accepted = sessions.filter((result) => result.code === 0 && result.stdout.includes('"completed": false'));
const rejected = sessions.filter((result) => result.code !== 0 && result.stderr.includes("nda_signing_conflict"));
if (accepted.length !== 1 || rejected.length !== 1) {
  throw new Error(`unexpected concurrent results: ${JSON.stringify(sessions)}`);
}

const verification = psqlSync(`
select concat_ws('|',
  s.signing_status,
  c.status,
  (select count(*) from public.nda_authority_audit_events
    where nda_id = '${ndaId}' and version_id = '${versionId}'
      and signer_id = '${signerId}' and event_type = 'signer.signed'),
  (select count(*) from public.nda_authority_audit_events
    where nda_id = '${ndaId}' and version_id = '${versionId}'
      and signer_id = '${signerId}' and event_type = 'capability.consumed'),
  (select count(*) from public.nda_authority_audit_events
    where nda_id = '${ndaId}' and version_id = '${versionId}'
      and event_type in ('version.completed','authority.completed')),
  v.lifecycle_status,
  a.lifecycle_status,
  (select signing_status from public.nda_authority_signers
    where id = '60000000-0000-4000-8000-000000000005')
)
from public.nda_authority_signers s
join public.nda_authority_capabilities c
  on (c.nda_id,c.version_id,c.signer_id) = (s.nda_id,s.version_id,s.id)
join public.nda_authority_versions v on (v.nda_id,v.id) = (s.nda_id,s.version_id)
join public.nda_authority_contracts a on a.id = s.nda_id
where s.id = '${signerId}';
`);
if (verification.status !== 0) throw new Error(`verification query failed: ${verification.stderr}`);
const state = verification.stdout.trim().split(/\s+/).at(-1);
if (state !== "signed|consumed|1|1|0|issued|active|pending") {
  throw new Error(`inconsistent post-concurrency state: ${state}`);
}

process.stdout.write(`${JSON.stringify({
  observed_waiting_sessions: observedWaiters,
  session_results: sessions.map((result, index) => ({
    session: index + 1,
    result: result.code === 0 ? "accepted" :
      (result.stderr.includes("nda_signing_conflict") ? "rejected_conflict" : "unexpected_failure"),
  })),
  accepted: accepted.length,
  rejected_conflict: rejected.length,
  final_state: state,
})}\n`);

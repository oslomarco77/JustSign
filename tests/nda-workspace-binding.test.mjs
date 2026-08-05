import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const A = require(resolve(ROOT, "api/_nda_authority.js"));
const SQL = readFileSync(resolve(ROOT, "api/nda_workspace_binding_authority.sql"), "utf8");
const IDS = {
  nda_id: "70000000-0000-4000-8000-000000000001",
  version_id: "70000000-0000-4000-8000-000000000002",
  workspace_id: "70000000-0000-4000-8000-000000000003",
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY",
    "NDA_WORKSPACE_BINDING_API_KEY", "NDA_WORKSPACE_BINDING_PRINCIPAL",
  ]) delete process.env[key];
});

function body(overrides = {}) {
  return { action: "reserve_workspace_binding", ...IDS, ...overrides };
}

function loadEndpoint() {
  const path = resolve(ROOT, "api/nda-authority.js");
  delete require.cache[require.resolve(path)];
  return require(path);
}

function response() {
  return {
    headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

describe("NDA Workspace binding API authority", () => {
  it("accepts only stable identifiers and an environment-derived trusted principal", () => {
    expect(A.bindingRequest(body(), "workspace-adapter:v1")).toEqual({
      ndaId: IDS.nda_id,
      versionId: IDS.version_id,
      workspaceId: IDS.workspace_id,
      actorPrincipal: "workspace-adapter:v1",
    });
    for (const extra of [
      { signing_status: "completed" }, { binding_status: "bound" },
      { document_hash: `sha256:${"0".repeat(64)}` }, { signer_count: 2 },
      { signed_document_reference: "made-up.pdf" },
    ]) expect(() => A.bindingRequest(body(extra), "workspace-adapter:v1")).toThrow(/invalid_request/);
    expect(() => A.bindingRequest(body({ workspace_id: "workspace-name" }), "workspace-adapter:v1"))
      .toThrow(/invalid_workspace_id/);
    expect(() => A.bindingRequest(body(), "browser supplied actor"))
      .toThrow(/invalid_binding_principal/);
  });

  it("sends only minimized authority identifiers to persistence", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    const endpoint = loadEndpoint();
    let rpcBody;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      rpcBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ outcome: "reserved", created: true }) };
    }));
    await endpoint.persistBinding(A.bindingRequest(body(), "workspace-adapter:v1"));
    expect(rpcBody).toEqual({
      p_nda_id: IDS.nda_id,
      p_version_id: IDS.version_id,
      p_workspace_id: IDS.workspace_id,
      p_actor_principal: "workspace-adapter:v1",
    });
    expect(JSON.stringify(rpcBody)).not.toMatch(/capability|signature|canonical_payload|national_id/);
  });

  it("requires the dedicated trusted-backend credential and returns no-store", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    process.env.NDA_WORKSPACE_BINDING_API_KEY = "binding-secret";
    process.env.NDA_WORKSPACE_BINDING_PRINCIPAL = "workspace-adapter:v1";
    const endpoint = loadEndpoint();
    const denied = response();
    await endpoint({ method: "POST", headers: { "content-type": "application/json" }, body: body() }, denied);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["Cache-Control"]).toBe("no-store");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        outcome: "reserved", created: true, binding_id: "70000000-0000-4000-8000-000000000004",
        ...IDS, binding_status: "reserved", document_hash: `sha256:${"a".repeat(64)}`,
        authority_package_reference: `nda-authority:${IDS.nda_id}/${IDS.version_id}`,
      }),
    })));
    const accepted = response();
    await endpoint({
      method: "POST",
      headers: { "content-type": "application/json", "x-signdee-binding-key": "binding-secret" },
      body: body(),
    }, accepted);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.body.binding_status).toBe("reserved");
    expect(accepted.body).not.toHaveProperty("actor_principal");
    expect(accepted.headers["Cache-Control"]).toBe("no-store");
  });

  it("maps idempotent replay, target conflict, eligibility failure, and internal errors", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    process.env.NDA_WORKSPACE_BINDING_API_KEY = "binding-secret";
    process.env.NDA_WORKSPACE_BINDING_PRINCIPAL = "workspace-adapter:v1";
    const endpoint = loadEndpoint();
    const request = { method: "POST", headers: {
      "content-type": "application/json", "x-signdee-binding-key": "binding-secret",
    }, body: body() };

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
      outcome: "reserved", created: false, ...IDS, binding_status: "reserved",
    }) })));
    const replay = response();
    await endpoint(request, replay);
    expect(replay.statusCode).toBe(200);
    expect(replay.body.created).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ outcome: "conflict" }) })));
    const conflict = response();
    await endpoint(request, conflict);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toEqual({ ok: false, code: "workspace_binding_conflict" });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, json: async () => ({ message: "nda_binding_not_eligible" }),
    })));
    const denied = response();
    await endpoint(request, denied);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toEqual({ ok: false, code: "binding_not_authorized" });

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, json: async () => ({ message: "constraint secret_internal_name" }),
    })));
    const internal = response();
    await endpoint(request, internal);
    expect(internal.statusCode).toBe(500);
    expect(internal.body).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("NDA Workspace binding database contract", () => {
  it("separates reserved/bound lifecycle from signing lifecycle", () => {
    expect(SQL).toMatch(/binding_status text not null default 'reserved'/);
    expect(SQL).toMatch(/binding_status in \('reserved','bound'\)/);
    expect(SQL).not.toMatch(/binding_status[^\n]*(?:completed|signed|void|superseded)/);
  });

  it("enforces one NDA and one completed version per binding with an exact hash FK", () => {
    expect(SQL).toMatch(/nda_id uuid not null unique/);
    expect(SQL).toMatch(/version_id uuid not null unique/);
    expect(SQL).toMatch(/foreign key \(nda_id, version_id, document_hash\)[\s\S]*nda_authority_versions\(nda_id, id, document_hash\)/);
  });

  it("locks and rechecks authoritative completion, signers, and canonical hash", () => {
    expect(SQL).toMatch(/nda_authority_contracts[\s\S]*where id = p_nda_id for update/);
    expect(SQL).toMatch(/completed_version_id <> p_version_id/);
    expect(SQL).toMatch(/nda_authority_versions[\s\S]*nda_id = p_nda_id and id = p_version_id for update/);
    expect(SQL).toMatch(/lifecycle_status <> 'completed'/);
    expect(SQL).toMatch(/is_required and signing_status <> 'signed'/);
    expect(SQL).toMatch(/extensions\.digest\(convert_to\(v_version\.canonical_payload, 'UTF8'\), 'sha256'\)/);
  });

  it("uses a restricted security-definer RPC and denies direct role access", () => {
    expect(SQL).toMatch(/language plpgsql security definer\s+set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on public\.nda_workspace_binding_authorities from anon, authenticated, service_role/);
    expect(SQL).toMatch(/revoke all on function public\.nda_authority_reserve_workspace_binding[\s\S]*from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function public\.nda_authority_reserve_workspace_binding[\s\S]*to service_role/);
  });

  it("records reservations, idempotent replays, and conflicts without sensitive evidence", () => {
    for (const event of ["reserved", "idempotent_replay", "conflict"]) {
      expect(SQL).toContain(`workspace_binding.${event}`);
    }
    expect(SQL).not.toMatch(/capability_digest|signature_image|signing_evidence_digest|canonical_document jsonb/);
    expect(SQL).toMatch(/nda workspace binding audit events are append-only/);
  });
});

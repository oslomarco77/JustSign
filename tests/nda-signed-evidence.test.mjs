import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const A = require(resolve(ROOT, "api/_nda_authority.js"));
const SQL = readFileSync(resolve(ROOT, "api/nda_signed_evidence_authority.sql"), "utf8");
const EXECUTABLE_SQL = SQL.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
const IDS = {
  nda_id: "80000000-0000-4000-8000-000000000001",
  version_id: "80000000-0000-4000-8000-000000000002",
};
const REFERENCE = `sde_${"a".repeat(64)}`;

function loadEndpoint() {
  const path = resolve(ROOT, "lib/nda-authority-handler.js");
  delete require.cache[require.resolve(path)];
  return require(path);
}
function response() {
  return { headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "NDA_AUTHORITY_API_KEY"]) delete process.env[key];
});

describe("NDA signed-evidence API boundary", () => {
  it("accepts only identifiers for issue and an opaque authority reference for resolve", () => {
    expect(A.signedEvidenceRequest({ action: "issue_signed_evidence", ...IDS })).toEqual({
      action: "issue_signed_evidence", ndaId: IDS.nda_id, versionId: IDS.version_id,
    });
    expect(A.signedEvidenceRequest({ action: "resolve_signed_evidence",
      signed_document_reference: REFERENCE })).toEqual({
      action: "resolve_signed_evidence", signedDocumentReference: REFERENCE,
    });
    for (const extra of [{ completed: true }, { document_hash: "fake" },
      { authority_package_reference: `nda-authority:${IDS.nda_id}/${IDS.version_id}` },
      { signed_document_reference: "nda-authority:x/y" }, { pdf_url: "https://example.invalid/a.pdf" }]) {
      expect(() => A.signedEvidenceRequest({ action: "issue_signed_evidence", ...IDS, ...extra }))
        .toThrow(/invalid_/);
    }
  });

  it("sends only minimized identifiers and requires the trusted authority credential", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    process.env.NDA_AUTHORITY_API_KEY = "authority-secret";
    const endpoint = loadEndpoint();
    let rpcBody;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      rpcBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ created: true,
        signed_document_reference: REFERENCE, ...IDS }) };
    }));
    const denied = response();
    await endpoint({ method: "POST", headers: { "content-type": "application/json" },
      body: { action: "issue_signed_evidence", ...IDS } }, denied);
    expect(denied.statusCode).toBe(403);
    const accepted = response();
    await endpoint({ method: "POST", headers: { "content-type": "application/json",
      "x-signdee-authority-key": "authority-secret" },
      body: { action: "issue_signed_evidence", ...IDS } }, accepted);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers["Cache-Control"]).toBe("no-store");
    expect(rpcBody).toEqual({ p_nda_id: IDS.nda_id, p_version_id: IDS.version_id });
  });

  it("sanitizes eligibility, lookup, and unexpected database errors", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    process.env.NDA_AUTHORITY_API_KEY = "authority-secret";
    const endpoint = loadEndpoint();
    for (const [message, status, code] of [
      ["nda_signed_evidence_not_eligible", 403, "signed_evidence_not_eligible"],
      ["constraint secret_internal_name", 500, "internal_error"],
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ message }) })));
      const res = response();
      await endpoint({ method: "POST", headers: { "content-type": "application/json",
        "x-signdee-authority-key": "authority-secret" },
        body: { action: "issue_signed_evidence", ...IDS } }, res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ ok: false, code });
    }
  });
});

describe("NDA signed-evidence database contract", () => {
  it("locks and proves exact completed authority, hash, signer evidence, and consent", () => {
    expect(SQL).toMatch(/nda_authority_contracts[\s\S]*where id = p_nda_id for update/);
    expect(SQL).toMatch(/completed_version_id <> p_version_id/);
    expect(SQL).toMatch(/nda_authority_versions[\s\S]*nda_id = p_nda_id and id = p_version_id for update/);
    expect(SQL).toMatch(/extensions\.digest\(convert_to\(v_version\.canonical_payload, 'UTF8'\), 'sha256'\)/);
    expect(SQL).toContain("SIGNDEE-NDA-SIGNING-EVIDENCE-V1");
    expect(SQL).toContain("signdee.nda.signing-consent.v1");
  });

  it("stores a deterministic immutable manifest behind a distinct opaque reference", () => {
    expect(SQL).toMatch(/signed_document_reference text not null unique/);
    expect(SQL).toContain("sde_");
    expect(SQL).toMatch(/jsonb_agg\([\s\S]*order by signing_order, id/);
    expect(SQL).toMatch(/signer_evidence_set_digest = extensions\.digest/);
    expect(SQL).toMatch(/before update or delete on public\.nda_signed_evidence_authorities/);
    expect(EXECUTABLE_SQL).not.toMatch(/authority_package_reference|nda-authority:|pdf|nda_contracts/);
  });

  it("denies direct access and exposes only reviewed service-role RPCs", () => {
    expect(SQL).toMatch(/revoke all on public\.nda_signed_evidence_authorities[\s\S]*from anon, authenticated, service_role/);
    expect(SQL).toMatch(/language plpgsql security definer[\s\S]*set search_path = public, pg_temp/);
    expect(SQL).toMatch(/grant execute on function public\.nda_authority_issue_signed_evidence[\s\S]*to service_role/);
    expect(SQL).toMatch(/grant execute on function public\.nda_authority_resolve_signed_evidence[\s\S]*to service_role/);
  });
});

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const A = require(resolve(ROOT, "api/_nda_authority.js"));
const SQL = readFileSync(resolve(ROOT, "api/nda_authority_signing.sql"), "utf8");
const CAPABILITY = Buffer.alloc(32, 7).toString("base64url");
const IDS = {
  nda_id: "00000000-0000-4000-8000-000000000001",
  version_id: "00000000-0000-4000-8000-000000000002",
  signer_id: "00000000-0000-4000-8000-000000000003",
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.NDA_AUTHORITY_API_KEY;
});

function signingBody(overrides = {}) {
  return { action: "sign", ...IDS, capability: CAPABILITY, consent: true, ...overrides };
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

describe("NDA signing API authority boundary", () => {
  it("validates a 256-bit capability and derives only its SHA-256 digest", () => {
    expect(A.digestCapability(CAPABILITY)).toBe(createHash("sha256").update(CAPABILITY).digest("hex"));
    for (const malformed of ["", "predictable", `${CAPABILITY}x`, "!".repeat(43)]) {
      expect(() => A.digestCapability(malformed)).toThrow(/invalid_signing_capability/);
    }
  });

  it("accepts only intent fields and rejects client-authored authority evidence", () => {
    const request = A.signingRequest(signingBody());
    expect(request).toEqual({
      ndaId: IDS.nda_id,
      versionId: IDS.version_id,
      signerId: IDS.signer_id,
      capabilityDigest: createHash("sha256").update(CAPABILITY).digest("hex"),
      consentSchema: A.SIGNING_CONSENT_SCHEMA,
    });
    for (const extra of [
      { signed_at: "2020-01-01T00:00:00Z" }, { completed: true },
      { document_hash: "fake" }, { signature_image: "data:image/png;base64,AA==" },
    ]) expect(() => A.signingRequest(signingBody(extra))).toThrow(/invalid_request/);
    expect(() => A.signingRequest(signingBody({ consent: false }))).toThrow(/consent_required/);
  });

  it("sends a digest, never plaintext capability or raw signature evidence, to the RPC", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    const endpoint = loadEndpoint();
    let rpcBody;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      rpcBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ...IDS, signed_at: "2026-08-05T00:00:00Z", completed: false }) };
    }));
    await endpoint.persistSignature(A.signingRequest(signingBody()));
    const serialized = JSON.stringify(rpcBody);
    expect(rpcBody.p_capability_digest).toBe(createHash("sha256").update(CAPABILITY).digest("hex"));
    expect(serialized).not.toContain(CAPABILITY);
    expect(serialized).not.toMatch(/signature_image|base64|signed_at|completed/);
  });

  it("permits signer capability authorization without exposing the internal creation key", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    const endpoint = loadEndpoint();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...IDS, signed_at: "2026-08-05T00:00:00Z", completed: false }),
    })));
    const res = response();
    await endpoint({ method: "POST", headers: { "content-type": "application/json" }, body: signingBody() }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toEqual({ ok: true, ...IDS, signed_at: "2026-08-05T00:00:00Z", completed: false });
    expect(JSON.stringify(res.body)).not.toContain(CAPABILITY);
  });

  it("sanitizes database failures and preserves only reviewed public conflicts", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-role";
    const endpoint = loadEndpoint();
    for (const [message, expectedStatus, expectedCode] of [
      ["nda_signing_not_authorized", 403, "signing_not_authorized"],
      ["nda_signing_conflict", 409, "signing_conflict"],
      ["duplicate key violates constraint secret_constraint", 500, "internal_error"],
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ message }) })));
      const res = response();
      await endpoint({ method: "POST", headers: { "content-type": "application/json" }, body: signingBody() }, res);
      expect(res.statusCode).toBe(expectedStatus);
      expect(res.body).toEqual({ ok: false, code: expectedCode });
      expect(JSON.stringify(res.body)).not.toContain("constraint");
    }
  });
});

describe("NDA transactional signing database contract", () => {
  it("uses one security-definer transaction boundary with a restricted search path and grant", () => {
    expect(SQL).toMatch(/nda_authority_sign_version\([\s\S]*language plpgsql security definer\s+set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on function public\.nda_authority_sign_version[\s\S]*from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function public\.nda_authority_sign_version[\s\S]*to service_role/);
    expect(SQL).toMatch(/alter function public\.nda_authority_sign_version[\s\S]*owner to postgres/);
  });

  it("locks the exact version, signer, and digest-bound capability before mutation", () => {
    expect(SQL).toMatch(/nda_authority_versions[\s\S]*nda_id = p_nda_id and id = p_version_id for update/);
    expect(SQL).toMatch(/nda_authority_signers[\s\S]*nda_id = p_nda_id and version_id = p_version_id and id = p_signer_id for update/);
    expect(SQL).toMatch(/nda_authority_capabilities[\s\S]*nda_id = p_nda_id and version_id = p_version_id and signer_id = p_signer_id[\s\S]*capability_digest = decode\(p_capability_digest, 'hex'\)[\s\S]*for update/);
  });

  it("rechecks canonical integrity and permits only issued versions", () => {
    expect(SQL).toMatch(/v_version\.lifecycle_status <> 'issued'/);
    expect(SQL).toMatch(/v_version\.canonical_document <> v_version\.canonical_payload::jsonb/);
    expect(SQL).toMatch(/extensions\.digest\(convert_to\(v_version\.canonical_payload, 'UTF8'\), 'sha256'\) <> v_version\.document_hash/);
  });

  it("atomically binds signer evidence, consumption, audit, and same-version completion", () => {
    expect(SQL).toMatch(/set signing_status = 'signed', signed_at = v_accepted_at/);
    expect(SQL).toMatch(/set status = 'consumed', consumed_at = v_accepted_at/);
    expect(SQL).toMatch(/'signer\.signed'[\s\S]*'capability\.consumed'/);
    expect(SQL).toMatch(/nda_id = p_nda_id and version_id = p_version_id[\s\S]*is_required and signing_status <> 'signed'/);
    expect(SQL).toMatch(/set lifecycle_status = 'completed', completed_at = v_accepted_at/);
    expect(SQL).toMatch(/'authority\.completed'/);
  });

  it("keeps terminal lifecycle and authority evidence immutable", () => {
    expect(SQL).toMatch(/old\.lifecycle_status in \('completed','void','superseded'\)[\s\S]*terminal nda authority version is immutable/);
    expect(SQL).toMatch(/immutable nda authority signing evidence/);
    expect(SQL).toMatch(/immutable nda authority contract completion/);
    expect(SQL).toMatch(/new\.canonical_payload <> old\.canonical_payload[\s\S]*new\.document_hash <> old\.document_hash/);
  });

  it("stores no capability plaintext or visual signature material", () => {
    expect(SQL).not.toMatch(/capability_plaintext|raw_capability|signature_image|base64_signature/);
    expect(SQL).toContain("signing_evidence_digest bytea");
    expect(SQL).toContain("consent_schema text");
  });
});

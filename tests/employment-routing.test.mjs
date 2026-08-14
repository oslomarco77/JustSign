/**
 * SD-407D — internal routing for the Employment endpoints.
 *
 * The Hobby plan allows 12 Serverless Functions and this repository had 14:
 * api/employment-authority.js and api/employment-sign.js were the extras. Both
 * moved to lib/ so they stop being Functions, and their public URLs now reach
 * them through vercel.json rewrites into api/myip.js.
 *
 * What these tests defend:
 *   1. both public URLs still resolve to the right handler
 *   2. delegation happens BEFORE myip's CORS/OPTIONS block, so each handler
 *      keeps deciding method validity for itself — a marked OPTIONS must stay
 *      405, never become myip's 200
 *   3. the two handlers keep their DIFFERENT authentication models: the
 *      authority handler needs a header key, the signing handler needs only
 *      the signer capability in the body
 *   4. the SD-407B1 NDA marker still behaves exactly as before
 *
 * All external I/O is stubbed. No Supabase, Sign Dee, Vercel, LINE, payment
 * system or real receiver is contacted.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const VERCEL = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8"));
const CAPABILITY = "A".repeat(43);

afterEach(() => vi.restoreAllMocks());

function response() {
  return {
    headers: {}, statusCode: 0, body: null, ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

function rewriteFor(source) {
  return VERCEL.rewrites.find((entry) => entry.source === source);
}

describe("SD-407D vercel routing configuration", () => {
  it("maps /api/employment-authority to its internal marker", () => {
    const rewrite = rewriteFor("/api/employment-authority");
    expect(rewrite).toBeDefined();
    expect(rewrite.destination).toBe("/api/myip?__sd_route=employment-authority");
  });

  it("maps /api/employment-sign to its internal marker", () => {
    const rewrite = rewriteFor("/api/employment-sign");
    expect(rewrite).toBeDefined();
    expect(rewrite.destination).toBe("/api/myip?__sd_route=employment-sign");
  });

  it("keeps the SD-407B1 NDA rewrite and the rest of the configuration", () => {
    expect(rewriteFor("/api/nda-authority").destination)
      .toBe("/api/myip?__sd_route=nda-authority");
    expect(VERCEL.installCommand).toBe("echo skip");
    expect(VERCEL.crons.some((cron) => cron.path === "/api/reminder-cron")).toBe(true);
    expect(VERCEL.functions["api/myip.js"].maxDuration).toBe(60);
    expect(Array.isArray(VERCEL.headers)).toBe(true);
    expect(Array.isArray(VERCEL.redirects)).toBe(true);
  });

  it("does not declare the moved handlers as Functions", () => {
    for (const key of Object.keys(VERCEL.functions)) {
      expect(key.startsWith("lib/")).toBe(false);
    }
    expect(Object.keys(VERCEL.functions)).not.toContain("api/employment-authority.js");
    expect(Object.keys(VERCEL.functions)).not.toContain("api/employment-sign.js");
  });
});

describe("SD-407D public function count", () => {
  it("no longer ships the Employment endpoints as Functions", () => {
    expect(existsSync(resolve(ROOT, "api/employment-authority.js"))).toBe(false);
    expect(existsSync(resolve(ROOT, "api/employment-sign.js"))).toBe(false);
    expect(existsSync(resolve(ROOT, "lib/employment-authority-handler.js"))).toBe(true);
    expect(existsSync(resolve(ROOT, "lib/employment-sign-handler.js"))).toBe(true);
  });

  it("exposes exactly 12 public api functions", () => {
    const publicFunctions = readdirSync(resolve(ROOT, "api"))
      .filter((name) => /\.(js|ts)$/.test(name) && !name.startsWith("_"));

    expect(publicFunctions).not.toContain("employment-authority.js");
    expect(publicFunctions).not.toContain("employment-sign.js");
    expect(publicFunctions).toHaveLength(12);
  });

  it("keeps both handlers loadable with their exports intact", () => {
    const authority = require(resolve(ROOT, "lib/employment-authority-handler.js"));
    const signing = require(resolve(ROOT, "lib/employment-sign-handler.js"));

    expect(typeof authority).toBe("function");
    expect(typeof signing).toBe("function");
    expect(typeof signing.persistSigning).toBe("function");
    expect(typeof authority.authorizeEmploymentSigners).toBe("function");
  });
});

describe("SD-407D marked-request delegation", () => {
  it("routes a marked Employment authority POST to its own auth boundary", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    // No SUPABASE_URL/SERVICE_KEY and no authority key in this environment, so
    // the handler stops at 503 or 403 — never a success, never myip's own
    // response. Either status proves the Employment handler answered.
    const res = response();
    await myip({
      method: "POST",
      query: { __sd_route: "employment-authority" },
      headers: { "content-type": "application/json" },
      body: { action: "authorize_signers", version_id: "91000000-0000-4000-8000-000000000001" },
    }, res);

    expect([403, 503]).toContain(res.statusCode);
    expect(res.body.ok).toBe(false);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    // Delegation happened before myip set its CORS headers.
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("routes a marked Employment signing POST to its own boundary", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    const res = response();
    await myip({
      method: "POST",
      query: { __sd_route: "employment-sign" },
      headers: { "content-type": "application/json" },
      body: { capability: CAPABILITY, signature_input: "drawn intent", consent: true },
    }, res);

    // signing_not_configured — the signing handler's own 503, distinct from the
    // authority handler's authorization_failed.
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, code: "signing_not_configured" });
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("cannot be used to bypass Employment authority authentication", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    // The marker is not a credential. Even with a plausible body and the right
    // content type, the request must never succeed without the authority key.
    for (const body of [
      { action: "authorize_signers", version_id: "91000000-0000-4000-8000-000000000001" },
      { action: "issue_signed_evidence", employment_id: "91000000-0000-4000-8000-000000000001",
        version_id: "91000000-0000-4000-8000-000000000002" },
      { action: "deliver_workspace_acceptance",
        binding_id: "91000000-0000-4000-8000-000000000003",
        signed_document_reference: `sde_emp_${"c".repeat(64)}` },
    ]) {
      const res = response();
      await myip({
        method: "POST",
        query: { __sd_route: "employment-authority" },
        headers: { "content-type": "application/json" },
        body,
      }, res);

      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).not.toBe(201);
      expect(res.body.ok).toBe(false);
    }
  });

  it("keeps the handler's 405 for a marked OPTIONS instead of myip's 200", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    for (const marker of ["employment-authority", "employment-sign"]) {
      const res = response();
      await myip({ method: "OPTIONS", query: { __sd_route: marker }, headers: {} }, res);

      expect(res.statusCode).toBe(405);
      expect(res.body).toEqual({ ok: false, code: "method_not_allowed" });
      expect(res.ended).toBe(false);
      expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    }
  });

  it("keeps the handler's 405 for a marked GET", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    for (const marker of ["employment-authority", "employment-sign"]) {
      const res = response();
      await myip({ method: "GET", query: { __sd_route: marker }, headers: {} }, res);
      expect(res.statusCode).toBe(405);
    }
  });
});

describe("SD-407D preserved behaviour", () => {
  it("still accepts the signer-capability flow with no Employment authority header", async () => {
    const Authority = require(resolve(ROOT, "api/_employment_authority.js"));
    const signing = require(resolve(ROOT, "lib/employment-sign-handler.js"));

    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      calls.push([url, options]);
      return {
        ok: true,
        json: async () => ({
          created: true, employment_id: "e", version_id: "v", signer_id: "s",
          signer_role: "employee", document_hash: "sha256:h", signed_at: "now",
        }),
      };
    }));

    const result = await signing.persistSigning(Authority.signingRequest({
      capability: CAPABILITY, signature_input: "drawn intent", consent: true,
    }));

    expect(result.created).toBe(true);
    // No authority key was supplied anywhere, and none was required.
    const sent = JSON.stringify(calls[0][1]);
    expect(sent).not.toContain("x-signdee-employment-authority-key");
    // Raw capability and raw intent are still hashed before persistence.
    expect(sent).not.toContain(CAPABILITY);
    expect(sent).not.toContain("drawn intent");
  });

  it("leaves unmarked myip untouched", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    const res = response();
    await myip({ method: "OPTIONS", query: {}, headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.body).toBeNull();
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
  });

  it("keeps SD-407B1 NDA marker routing unchanged", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    const res = response();
    await myip({ method: "GET", query: { __sd_route: "nda-authority" }, headers: {} }, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ ok: false, code: "method_not_allowed" });
  });

  it("falls through to myip for an unrecognised marker", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    const res = response();
    await myip({ method: "OPTIONS", query: { __sd_route: "not-a-route" }, headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });
});

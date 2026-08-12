/**
 * SD-407B1 — internal routing for the NDA Authority endpoint.
 *
 * The Hobby plan allows 12 Serverless Functions. The Authority handler moved
 * out of api/ so it stops being one, and /api/nda-authority now reaches it via
 * an internal vercel.json rewrite through api/myip.js.
 *
 * These tests protect the two things that could silently break:
 *   1. the public URL keeps working (rewrite wiring, delegation)
 *   2. myip.js is otherwise untouched for every ordinary request
 *
 * No Supabase, payment, LINE or Production service is contacted. The Authority
 * handler is exercised only through a path that returns before any fetch.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const VERCEL = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8"));

function response() {
  return {
    headers: {}, statusCode: 0, body: null, ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

describe("SD-407B1 internal routing", () => {
  it("rewrites the public endpoint to myip with the private route marker", () => {
    expect(Array.isArray(VERCEL.rewrites)).toBe(true);

    const rewrite = VERCEL.rewrites.find((entry) => entry.source === "/api/nda-authority");

    expect(rewrite).toBeDefined();
    expect(rewrite.source).toBe("/api/nda-authority");
    expect(rewrite.destination).toBe("/api/myip?__sd_route=nda-authority");
  });

  it("preserves the existing vercel.json configuration", () => {
    expect(VERCEL.installCommand).toBe("echo skip");
    expect(VERCEL.crons.some((cron) => cron.path === "/api/reminder-cron")).toBe(true);
    expect(VERCEL.functions["api/myip.js"].maxDuration).toBe(60);
    expect(Array.isArray(VERCEL.headers)).toBe(true);
    expect(Array.isArray(VERCEL.redirects)).toBe(true);
    // The moved handler must not be re-declared as a Function.
    expect(Object.keys(VERCEL.functions)).not.toContain("api/nda-authority.js");
  });

  it("no longer ships a public nda-authority Function", () => {
    expect(existsSync(resolve(ROOT, "api/nda-authority.js"))).toBe(false);
    expect(existsSync(resolve(ROOT, "api/nda-authority.ts"))).toBe(false);

    const publicFunctions = readdirSync(resolve(ROOT, "api"))
      .filter((name) => /\.(js|ts)$/.test(name) && !name.startsWith("_"));

    expect(publicFunctions).not.toContain("nda-authority.js");
    expect(publicFunctions).not.toContain("nda-authority.ts");
  });

  it("keeps the handler outside api/ and loadable from lib/", () => {
    expect(existsSync(resolve(ROOT, "lib/nda-authority-handler.js"))).toBe(true);

    const handler = require(resolve(ROOT, "lib/nda-authority-handler.js"));

    expect(typeof handler).toBe("function");
    // The exported persistence functions must survive the move.
    for (const name of ["persistAuthority", "persistSignature", "persistBinding"]) {
      expect(typeof handler[name]).toBe("function");
    }
  });

  it("delegates a marked request to the Authority handler, not to myip", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    // GET is rejected by the Authority handler with 405 method_not_allowed.
    // myip's own GET path returns an IP payload with 200, so the status alone
    // proves which handler answered.
    const res = response();
    await myip({ method: "GET", query: { __sd_route: "nda-authority" }, headers: {} }, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ ok: false, code: "method_not_allowed" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    // Delegation happens before myip sets its own CORS headers.
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("does not let the marker short-circuit the Authority handler's own auth", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    // A marked POST with the right content type still has to satisfy the
    // Authority handler. With no SUPABASE_URL/SERVICE_KEY configured in the
    // test environment it stops at 503 — never a success, never a bypass.
    const res = response();
    await myip({
      method: "POST",
      query: { __sd_route: "nda-authority" },
      headers: { "content-type": "application/json" },
      body: { action: "resolve_signed_evidence", signed_document_reference: `sde_${"0".repeat(64)}` },
    }, res);

    expect([403, 503]).toContain(res.statusCode);
    expect(res.body.ok).toBe(false);
  });

  it("leaves myip unchanged for a request without the marker", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    // OPTIONS is the earliest existing myip behaviour, immediately after the
    // dispatch point — if delegation leaked, this would not be a bare 200.
    const res = response();
    await myip({ method: "OPTIONS", query: {}, headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.body).toBeNull();
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
  });

  it("tolerates a request with no query object at all", async () => {
    const myip = require(resolve(ROOT, "api/myip.js"));

    const res = response();
    await myip({ method: "OPTIONS", headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });
});

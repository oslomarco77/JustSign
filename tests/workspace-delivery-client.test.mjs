/**
 * SD-407C — outbound delivery client.
 *
 * Every test stubs fetch. No Supabase, Sign Dee, Vercel, LINE, payment or any
 * other network service is contacted, and no real secret is used — the HMAC
 * key material here is a literal test string.
 *
 * The signing assertions deliberately re-derive expected values from the
 * committed generated contract rather than hard-coding them, so a contract
 * change surfaces here instead of silently diverging from Sign Dee.
 */
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const Client = require(resolve(ROOT, "lib/workspace-delivery-client.js"));
const Contract = require(resolve(ROOT, "api/_esign_contract.generated.js"));

const AUTH = Contract.CONTRACT.service_auth;
const H = AUTH.headers;

const KEY_ID = "justsign-test-key";
const SECRET = "not-a-real-secret-test-only";
const BASE = "https://receiver.test";

const ENV = {
  SIGNDEE_RECEIVER_BASE_URL: BASE,
  SIGNDEE_RECEIVER_HMAC_KEY_ID: KEY_ID,
  SIGNDEE_RECEIVER_HMAC_SECRET: SECRET,
};

const BINDING = "a3000000-0000-4000-8000-000000000001";
const EXTERNAL = "a7000000-0000-4000-8000-000000000009";
const WORKSPACE = "a8859a05-a2bd-46c5-a459-203b973bb97a";
const NDA_REF = `sde_${"b".repeat(64)}`;
const EMP_REF = `sde_emp_${"c".repeat(64)}`;

function jsonResponse(status, body, overrides = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Map([
    ["content-type", overrides.contentType ?? "application/json; charset=utf-8"],
  ]);
  if (overrides.contentLength !== undefined) {
    headers.set("content-length", String(overrides.contentLength));
  }
  return {
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => text,
  };
}

const okBody = {
  ok: true,
  created: true,
  binding_id: BINDING,
  workspace_id: WORKSPACE,
  external_contract_id: EXTERNAL,
};

/** Captures the single fetch call so headers and body bytes can be asserted. */
function recorder(response = jsonResponse(200, okBody)) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
  return { calls, fetch };
}

async function deliver(product, input, deps = {}) {
  return Client.deliverWorkspaceAcceptance(product, input, { env: ENV, ...deps });
}

describe("SD-407C canonical signing", () => {
  it("signs exactly the contract's canonical string", async () => {
    const rec = recorder();
    await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch, nonce: "nonce0000000000000001", nowSeconds: 1785000000 });

    const { init } = rec.calls[0];
    const path = Client.RECEIVER_PATHS.nda;
    const contentSha256 = createHash("sha256").update(init.body).digest("hex");

    const canonical = [
      AUTH.version, KEY_ID, "1785000000", "nonce0000000000000001", "POST", path, contentSha256,
    ].join(AUTH.canonical_string_separator);

    expect(canonical).toBe(Contract.buildCanonicalString({
      keyId: KEY_ID, timestamp: "1785000000", nonce: "nonce0000000000000001",
      method: "POST", path, contentSha256,
    }));
    expect(init.headers[H.signature])
      .toBe(createHmac("sha256", SECRET).update(canonical).digest("hex"));
    expect(init.headers[H.signature]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the exact bytes it sends", async () => {
    const rec = recorder();
    await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch });

    const { init } = rec.calls[0];
    expect(typeof init.body).toBe("string");
    expect(init.headers[H.content_sha256])
      .toBe(createHash("sha256").update(init.body).digest("hex"));
  });

  it("sends every canonical header and a JSON content type", async () => {
    const rec = recorder();
    await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch });

    const sent = rec.calls[0].init.headers;
    for (const name of Object.values(H)) expect(typeof sent[name]).toBe("string");
    expect(sent[H.key_id]).toBe(KEY_ID);
    expect(sent["content-type"]).toBe("application/json");
    expect(sent[H.timestamp]).toMatch(/^\d{10}$/);
  });

  it("uses a fresh valid nonce and timestamp on every attempt", async () => {
    const rec = recorder();
    const args = ["nda", { binding_id: BINDING, signed_document_reference: NDA_REF }];
    await deliver(...args, { fetch: rec.fetch });
    await deliver(...args, { fetch: rec.fetch });

    const [a, b] = rec.calls.map((c) => c.init.headers);
    expect(a[H.nonce]).not.toBe(b[H.nonce]);
    for (const n of [a[H.nonce], b[H.nonce]]) {
      expect(n).toMatch(new RegExp(AUTH.nonce_pattern));
    }
    expect(Number(a[H.timestamp])).toBeGreaterThan(1700000000);
  });

  it("keeps binding_id and evidence stable across caller-driven retries", async () => {
    const rec = recorder();
    const args = ["nda", { binding_id: BINDING, signed_document_reference: NDA_REF }];
    await deliver(...args, { fetch: rec.fetch });
    await deliver(...args, { fetch: rec.fetch });

    expect(rec.calls[0].init.body).toBe(rec.calls[1].init.body);
    expect(JSON.parse(rec.calls[0].init.body).binding_id).toBe(BINDING);
  });
});

describe("SD-407C payload and routing", () => {
  it("posts exactly the two-key payload", async () => {
    const rec = recorder();
    await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch });

    const parsed = JSON.parse(rec.calls[0].init.body);
    expect(Object.keys(parsed)).toEqual(["binding_id", "signed_document_reference"]);
    expect(parsed.signed_document_reference).toBe(NDA_REF);
  });

  it("routes NDA and Employment to their own receiver paths", async () => {
    const nda = recorder();
    await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: nda.fetch });
    expect(nda.calls[0].url)
      .toBe(`${BASE}/api/integration/justsign/nda-workspace-acceptance`);

    const emp = recorder();
    await deliver("employment", { binding_id: BINDING, signed_document_reference: EMP_REF },
      { fetch: emp.fetch });
    expect(emp.calls[0].url)
      .toBe(`${BASE}/api/integration/justsign/employment-workspace-acceptance`);
  });

  it("rejects the wrong evidence shape for the product", async () => {
    const rec = recorder();
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: EMP_REF },
      { fetch: rec.fetch })).rejects.toMatchObject({ code: "invalid_signed_document_reference" });
    await expect(deliver("employment", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch })).rejects.toMatchObject({ code: "invalid_signed_document_reference" });
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses a client-supplied workspace_id and never transmits one", async () => {
    const rec = recorder();
    await expect(deliver("nda", {
      binding_id: BINDING, signed_document_reference: NDA_REF, workspace_id: WORKSPACE,
    }, { fetch: rec.fetch })).rejects.toMatchObject({ code: "invalid_delivery_input" });
    expect(rec.calls).toHaveLength(0);

    const clean = recorder();
    await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: clean.fetch });
    expect(clean.calls[0].init.body).not.toContain("workspace_id");
  });

  it("rejects an unknown product and a malformed binding id", async () => {
    await expect(deliver("sale", { binding_id: BINDING, signed_document_reference: NDA_REF }))
      .rejects.toMatchObject({ code: "invalid_product" });
    await expect(deliver("nda", { binding_id: "not-a-uuid", signed_document_reference: NDA_REF }))
      .rejects.toMatchObject({ code: "invalid_binding_id" });
  });
});

describe("SD-407C transport and response handling", () => {
  it("classifies a timeout as retryable", async () => {
    const fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch, env: { ...ENV, SIGNDEE_RECEIVER_TIMEOUT_MS: "1000" } }))
      .rejects.toMatchObject({ code: "delivery_timeout", retryable: true });
  });

  it("classifies a network failure as retryable", async () => {
    const fetch = async () => { throw new TypeError("fetch failed"); };
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch })).rejects.toMatchObject({ code: "delivery_network_error", retryable: true });
  });

  it("accepts and parses a valid 200", async () => {
    const rec = recorder();
    const result = await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch });
    expect(result).toEqual({
      created: true, binding_id: BINDING, workspace_id: WORKSPACE, external_contract_id: EXTERNAL,
    });
  });

  it("treats a 4xx as terminal", async () => {
    const rec = recorder(jsonResponse(409, { ok: false, code: "CONFLICT" }));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch })).rejects.toMatchObject({ code: "receiver_conflict", retryable: false });
  });

  it("treats 5xx and the contract's retryable codes as retryable", async () => {
    for (const [status, code] of [[500, "INTERNAL_ERROR"], [503, "INTERNAL_ERROR"]]) {
      const rec = recorder(jsonResponse(status, { ok: false, code }));
      await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
        { fetch: rec.fetch })).rejects.toMatchObject({ retryable: true });
    }
    const limited = recorder(jsonResponse(429, { ok: false, code: "RATE_LIMITED" }));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: limited.fetch })).rejects.toMatchObject({ retryable: true });
  });

  it("rejects non-JSON, wrong content type and malformed JSON", async () => {
    const html = recorder(jsonResponse(200, "<html>gateway</html>",
      { contentType: "text/html" }));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: html.fetch })).rejects.toMatchObject({ code: "delivery_invalid_response" });

    const broken = recorder(jsonResponse(200, "{not json"));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: broken.fetch })).rejects.toMatchObject({ code: "delivery_invalid_response" });
  });

  it("rejects a response over 8192 bytes, declared or actual", async () => {
    expect(Client.MAX_RESPONSE_BYTES).toBe(8192);

    const declared = recorder(jsonResponse(200, okBody, { contentLength: 9000 }));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: declared.fetch })).rejects.toMatchObject({ code: "delivery_response_too_large" });

    const actual = recorder(jsonResponse(200, JSON.stringify({ ok: true, pad: "x".repeat(9000) })));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: actual.fetch })).rejects.toMatchObject({ code: "delivery_response_too_large" });
  });

  it("rejects a 200 whose body does not match the request identity", async () => {
    const wrong = recorder(jsonResponse(200, { ...okBody, binding_id: EXTERNAL }));
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: wrong.fetch })).rejects.toMatchObject({ code: "delivery_invalid_response" });
  });
});

describe("SD-407C configuration and redaction", () => {
  it("fails closed on missing configuration without sending", async () => {
    const rec = recorder();
    for (const key of Object.keys(ENV)) {
      const env = { ...ENV };
      delete env[key];
      await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
        { fetch: rec.fetch, env })).rejects.toMatchObject({ code: "delivery_not_configured" });
    }
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects a key id that violates the contract pattern", async () => {
    const rec = recorder();
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch, env: { ...ENV, SIGNDEE_RECEIVER_HMAC_KEY_ID: "bad key!" } }))
      .rejects.toMatchObject({ code: "delivery_misconfigured" });
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects a malformed base url and timeout", async () => {
    const rec = recorder();
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch, env: { ...ENV, SIGNDEE_RECEIVER_BASE_URL: "not a url" } }))
      .rejects.toMatchObject({ code: "delivery_misconfigured" });
    await expect(deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF },
      { fetch: rec.fetch, env: { ...ENV, SIGNDEE_RECEIVER_TIMEOUT_MS: "abc" } }))
      .rejects.toMatchObject({ code: "delivery_misconfigured" });
    expect(rec.calls).toHaveLength(0);
  });

  it("leaks no secret, signature, url, host or evidence reference in any error", async () => {
    const failures = [
      { fetch: async () => { throw new Error(`connect ECONNREFUSED ${BASE}`); } },
      { fetch: recorder(jsonResponse(500, { ok: false, code: "INTERNAL_ERROR", detail: SECRET })).fetch },
      { fetch: recorder(jsonResponse(200, `${SECRET} ${NDA_REF}`, { contentType: "text/plain" })).fetch },
    ];

    for (const deps of failures) {
      let caught;
      try {
        await deliver("nda", { binding_id: BINDING, signed_document_reference: NDA_REF }, deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      const surface = `${caught.message} ${caught.code} ${caught.stack ?? ""}`;
      for (const forbidden of [SECRET, NDA_REF, BASE, "receiver.test"]) {
        expect(surface).not.toContain(forbidden);
      }
    }
  });

  it("never logs", () => {
    const source = require("node:fs")
      .readFileSync(resolve(ROOT, "lib/workspace-delivery-client.js"), "utf8");
    expect(source).not.toMatch(/console\s*\./);
  });
});

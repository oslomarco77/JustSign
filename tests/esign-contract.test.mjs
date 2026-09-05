/**
 * SD-403 — e-Signature side: the generated contract consumer.
 *
 * This repository must never hand-maintain contract logic. These tests prove the
 * generated artifact is intact, self-contained, and behaves the same as the
 * source of truth in sign-dee.
 *
 * Regenerate the artifact from sign-dee, never edit it here:
 *   cd ../sign-dee
 *   node scripts/emit-esign-contract.mjs --out "../Sign-Dee-for Claude/justsign-api/api/_esign_contract.generated.js"
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const ARTIFACT = resolve(REPO_ROOT, "api/_esign_contract.generated.js");

const require = createRequire(import.meta.url);
const C = require(ARTIFACT);
const SOURCE = readFileSync(ARTIFACT, "utf8");

describe("generated contract artifact", () => {
  it("is marked generated and must not be hand-edited", () => {
    expect(SOURCE).toMatch(/GENERATED FILE — DO NOT EDIT BY HAND/);
    expect(SOURCE).toMatch(/canonical\.json/);
  });

  it("is self-contained: node built-ins only, no zod, no production dependency", () => {
    const requires = [...SOURCE.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
    expect(requires).toEqual(["node:crypto"]);
    expect(SOURCE).not.toMatch(/zod/);
    expect(SOURCE).not.toMatch(/@supabase/);
  });

  it("does not start as a Vercel serverless function (filename begins with _)", () => {
    expect(ARTIFACT.split("/").pop()).toMatch(/^_/);
  });

  it("carries a schema version and checksum", () => {
    expect(C.SCHEMA_VERSION).toBe("1.0.0");
    expect(C.CONTRACT_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when the peer reports a different contract", () => {
    expect(
      C.assertContractCompatible({
        schema_version: C.SCHEMA_VERSION,
        contract_checksum: C.CONTRACT_CHECKSUM,
      }),
    ).toBe(true);

    for (const peer of [
      null,
      undefined,
      {},
      { schema_version: "0.9.0", contract_checksum: C.CONTRACT_CHECKSUM },
      { schema_version: C.SCHEMA_VERSION, contract_checksum: "deadbeef" },
    ]) {
      expect(() => C.assertContractCompatible(peer)).toThrow(/contract mismatch/);
    }
  });
});

describe("canonical membership", () => {
  it("accepts exactly the four products", () => {
    expect([...C.CONTRACT.product_types].sort()).toEqual([
      "employment",
      "nda",
      "rental",
      "sale",
    ]);
    for (const p of C.CONTRACT.product_types) expect(C.isProductType(p)).toBe(true);
    expect(C.isProductType("loan")).toBe(false);
  });

  it("accepts every canonical status and event", () => {
    for (const s of C.CONTRACT.signing_statuses) expect(C.isSigningStatus(s)).toBe(true);
    for (const b of C.CONTRACT.binding_statuses) expect(C.isBindingStatus(b)).toBe(true);
    for (const e of C.CONTRACT.event_types) expect(C.isEventType(e)).toBe(true);
    expect(C.isSigningStatus("signed")).toBe(false);
    expect(C.isEventType("contract.deleted")).toBe(false);
  });
});

describe("transitions", () => {
  it("allows the documented signing transitions", () => {
    expect(C.isSigningTransitionAllowed("draft", "awaiting_signature")).toBe(true);
    expect(C.isSigningTransitionAllowed("awaiting_signature", "partially_signed")).toBe(true);
    expect(C.isSigningTransitionAllowed("partially_signed", "completed")).toBe(true);
  });

  it("rejects reverse transitions out of terminal statuses", () => {
    for (const terminal of C.CONTRACT.terminal_signing_statuses) {
      expect(C.isSigningTransitionAllowed(terminal, "draft")).toBe(false);
      expect(C.evaluateSigningTransition(terminal, "awaiting_signature")).toEqual({
        kind: "reject",
        reason: "terminal_source",
      });
    }
  });

  it("never allows relinking an unlinked contract to another workspace", () => {
    expect(C.isBindingTransitionAllowed("unbound", "bound")).toBe(true);
    expect(C.isBindingTransitionAllowed("bound", "unlinked")).toBe(true);
    expect(C.isBindingTransitionAllowed("unlinked", "bound")).toBe(false);
  });
});

describe("data minimisation", () => {
  it("rejects forbidden keys regardless of casing or separator", () => {
    for (const key of [
      "signature_image",
      "signatureImage",
      "Signature-Base64",
      "signing_token",
      "claim_code",
      "otp",
      "national_id",
      "full_address",
      "signed_url",
      "service_role_key",
    ]) {
      expect(C.isForbiddenKey(key), `${key} must be forbidden`).toBe(true);
    }
    for (const key of ["display_label", "signer_count", "contract_date"]) {
      expect(C.isForbiddenKey(key), `${key} must be allowed`).toBe(false);
    }
  });

  it("detects high-confidence forbidden value formats", () => {
    expect(C.detectForbiddenValue("data:image/png;base64,AAAA")).toBe("base64_image_data_url");
    expect(C.detectForbiddenValue("1101700207277")).toBe("thai_national_id");
    expect(C.detectForbiddenValue("-----BEGIN CERTIFICATE-----")).toBe("pem_block");
    expect(C.detectForbiddenValue("https://x/y.pdf?X-Amz-Signature=ab")).toBe("presigned_url");
    expect(C.detectForbiddenValue("ห้องนี้ต้องใช้บัตรประชาชนตอนโอน")).toBe(null);
  });

  it("enforces the positive allowlist and never echoes the value", () => {
    expect(C.validateMetadata({ display_label: "ห้อง 12/34", signer_count: 2 })).toEqual([]);

    const findings = C.validateMetadata({ buyer_nickname: "ken" });
    expect(findings).toEqual([{ path: "metadata.buyer_nickname", reason: "not_allowlisted" }]);

    const secret = "data:image/png;base64,SUPERSECRET";
    const leaked = C.validateMetadata({ display_label: secret });
    expect(leaked.length).toBeGreaterThan(0);
    expect(JSON.stringify(leaked)).not.toContain("SUPERSECRET");
  });

  it("does not mutate the scanned input", () => {
    const input = { display_label: "x", nested: { signature_image: "y" } };
    const before = JSON.stringify(input);
    C.scanForbidden(input, "metadata");
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("signed evidence", () => {
  const completed = {
    signing_status: "completed",
    document_version: "v3",
    document_hash: "sha256:" + "0".repeat(64),
    signed_document_reference: "signed:sale/42/v3",
    source_completed_at: "2026-08-02T10:00:00.000Z",
  };

  it("passes when all evidence is present", () => {
    expect(C.missingCompletedEvidence(completed)).toEqual([]);
  });

  it("reports each missing evidence field", () => {
    for (const field of C.CONTRACT.completed_evidence_required_fields) {
      const partial = { ...completed, [field]: null };
      expect(C.missingCompletedEvidence(partial)).toEqual([
        { path: field, reason: "required_when_completed" },
      ]);
    }
  });

  it("requires nothing for a non-completed status", () => {
    expect(C.missingCompletedEvidence({ signing_status: "partially_signed" })).toEqual([]);
  });
});

describe("idempotency", () => {
  const envelope = {
    schema_version: "1.0.0",
    source_system: "justsign",
    product_type: "sale",
    external_contract_id: "sale-42",
    event_type: "signature.completed",
    signing_status: "completed",
    binding_status: "bound",
    document_version: "v3",
    document_hash: "sha256:" + "0".repeat(64),
  };

  it("is independent of key insertion order", () => {
    const shuffled = Object.fromEntries(Object.entries(envelope).reverse());
    expect(C.canonicalizePayload(shuffled)).toBe(C.canonicalizePayload(envelope));
  });

  it("changes when the business payload changes", () => {
    const changed = { ...envelope, document_version: "v4" };
    expect(C.canonicalizePayload(changed)).not.toBe(C.canonicalizePayload(envelope));
    expect(C.idempotencyIdentity(changed)).not.toBe(C.idempotencyIdentity(envelope));
  });

  it("derives a deterministic key", () => {
    const key = C.computeIdempotencyKey(C.idempotencyIdentity(envelope));
    expect(key).toBe(C.computeIdempotencyKey(C.idempotencyIdentity(envelope)));
    expect(key).toMatch(/^sdi_[0-9a-f]{64}$/);
  });
});

describe("service auth parity", () => {
  const KEY_ID = "sd-test-key-1";
  const SECRET = "test-secret-not-a-real-credential";

  it("builds the versioned canonical string byte-for-byte", () => {
    expect(
      C.buildCanonicalString({
        keyId: KEY_ID,
        timestamp: "1785000000",
        nonce: "n1",
        method: "post",
        path: "/api/x",
        contentSha256: "ABCDEF",
      }),
    ).toBe(["SIGNDEE-HMAC-V1", KEY_ID, "1785000000", "n1", "POST", "/api/x", "abcdef"].join("\n"));
  });

  it("produces headers that verify against a recomputed signature", () => {
    const body = JSON.stringify({ event_type: "signature.completed" });
    const headers = C.buildAuthHeaders({
      keyId: KEY_ID,
      secret: SECRET,
      method: "POST",
      path: "/api/integration/events",
      rawBody: body,
      nonce: "nonce-0000000000000001",
      nowSeconds: 1785000000,
    });

    const expected = C.signRequest(
      {
        keyId: KEY_ID,
        timestamp: "1785000000",
        nonce: "nonce-0000000000000001",
        method: "POST",
        path: "/api/integration/events",
        contentSha256: C.sha256Hex(body),
      },
      SECRET,
    );

    expect(headers["x-signdee-signature"]).toBe(expected);
    expect(headers["x-signdee-content-sha256"]).toBe(C.sha256Hex(body));
    expect(C.constantTimeEquals(headers["x-signdee-signature"], expected)).toBe(true);
  });

  it("signature changes when body, path or method changes", () => {
    const parts = {
      keyId: KEY_ID,
      timestamp: "1785000000",
      nonce: "n1",
      method: "POST",
      path: "/a",
      contentSha256: C.sha256Hex("{}"),
    };
    const base = C.signRequest(parts, SECRET);
    expect(C.signRequest({ ...parts, path: "/b" }, SECRET)).not.toBe(base);
    expect(C.signRequest({ ...parts, method: "PUT" }, SECRET)).not.toBe(base);
    expect(C.signRequest({ ...parts, contentSha256: C.sha256Hex("{ }") }, SECRET)).not.toBe(base);
  });

  it("constant-time compare returns false for different lengths without throwing", () => {
    expect(C.constantTimeEquals("abc", "abcd")).toBe(false);
    expect(C.constantTimeEquals("abc", "abc")).toBe(true);
  });

  it("refuses to sign with an empty secret", () => {
    expect(() =>
      C.signRequest(
        { keyId: KEY_ID, timestamp: "1", nonce: "n", method: "POST", path: "/x", contentSha256: "aa" },
        "",
      ),
    ).toThrow();
  });
});

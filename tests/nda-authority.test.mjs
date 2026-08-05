import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const A = require(resolve(ROOT, "api/_nda_authority.js"));
const endpoint = require(resolve(ROOT, "api/nda-authority.js"));
const SQL = readFileSync(resolve(ROOT, "api/nda_authority_foundation.sql"), "utf8");
const LEGACY_BACKEND = readFileSync(resolve(ROOT, "api/myip.js"), "utf8");
const LEGACY_UI = readFileSync(resolve(ROOT, "index-nda.html"), "utf8");

afterEach(() => vi.unstubAllGlobals());

const authority = {
  ndaId: "00000000-0000-4000-8000-000000000001",
  versionId: "00000000-0000-4000-8000-000000000002",
  versionNumber: 1,
  signers: {
    a: { id: "00000000-0000-4000-8000-000000000003", partyRef: "00000000-0000-4000-8000-000000000004" },
    b: { id: "00000000-0000-4000-8000-000000000005", partyRef: "00000000-0000-4000-8000-000000000006" },
  },
};

function document(overrides = {}) {
  return {
    title: "สัญญารักษาความลับ",
    nda_type: "one_way",
    parties: {
      a: { identity_type: "individual", display_name: "ผู้ให้ข้อมูล", national_id: "ID-A", age_years: 35, address: "Bangkok", phone: "0800000000" },
      b: {
        identity_type: "juristic", display_name: "ผู้รับข้อมูล จำกัด", address: "Bangkok",
        juristic: {
          name: "ผู้รับข้อมูล จำกัด", registration_number: "REG-1", authorized_signer: "Signer B",
          registration_office: "Bangkok Registry", certificate_date: "2026-08-01",
          power_of_attorney_date: "2026-08-02", address_number: "1", road: "Silom",
          subdistrict: "Suriyawong", district: "Bang Rak", province: "Bangkok",
        },
      },
    },
    document_intro: "ผู้ให้ข้อมูลตกลงเปิดเผยข้อมูลโดยมีเงื่อนไขดังต่อไปนี้",
    document_closing: "คู่สัญญาอ่านและเข้าใจข้อความโดยตลอดแล้ว",
    place_of_execution: "Bangkok",
    effective_date: "2026-08-04",
    display_date: "4 สิงหาคม พ.ศ. 2569",
    confidential_information_scope: "POS source code",
    permitted_purpose: "outsourced development",
    duration_months: 12,
    start_date: "2026-08-04",
    end_date: "2027-08-04",
    clauses: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i + 1}`, `Clause ${i + 1}`])),
    governing_law: "Thailand",
    jurisdiction: "Bangkok",
    material_options: { mutual: false, disclosure_channels: ["written", "oral"] },
    exceptions: { public_information: true },
    additional_terms: "No additional disclosure.",
    ...overrides,
  };
}

describe("NDA canonical document", () => {
  it("is deterministic and independently hashable", () => {
    const first = A.buildCanonicalDocument(document(), authority);
    const second = A.buildCanonicalDocument(document(), authority);
    expect(second.canonical).toBe(first.canonical);
    expect(second.hash).toBe(first.hash);
    expect(first.hash).toBe(createHash("sha256").update(first.canonical, "utf8").digest("hex"));
  });

  it("ignores object insertion order but not array order", () => {
    const input = document();
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    reordered.parties = {
      b: Object.fromEntries(Object.entries(input.parties.b).reverse()),
      a: Object.fromEntries(Object.entries(input.parties.a).reverse()),
    };
    expect(A.buildCanonicalDocument(reordered, authority).canonical)
      .toBe(A.buildCanonicalDocument(input, authority).canonical);
  });

  it("changes the hash for every presented material field", () => {
    const base = A.buildCanonicalDocument(document(), authority).hash;
    const changes = [
      { title: "Mutual NDA" }, { nda_type: "mutual" },
      { document_intro: "Changed intro" }, { document_closing: "Changed closing" },
      { place_of_execution: "Chiang Mai" },
      { effective_date: "2026-08-05" }, { duration_months: 24 },
      { display_date: "5 สิงหาคม พ.ศ. 2569" },
      { confidential_information_scope: "Changed scope" }, { permitted_purpose: "Changed purpose" },
      { start_date: "2026-08-05" }, { end_date: "2028-08-05" },
      { governing_law: "Singapore" }, { jurisdiction: "Singapore" },
      { material_options: { mutual: true } }, { exceptions: { public_information: false } },
      { additional_terms: "Changed" },
      { parties: { ...document().parties, a: { ...document().parties.a, display_name: "Changed" } } },
    ];
    for (const change of changes) {
      expect(A.buildCanonicalDocument(document(change), authority).hash).not.toBe(base);
    }
    for (let index = 1; index <= 8; index++) {
      const clauses = { ...document().clauses, [`c${index}`]: `Changed ${index}` };
      expect(A.buildCanonicalDocument(document({ clauses }), authority).hash).not.toBe(base);
    }
  });

  it("covers stable version and signer authority identifiers", () => {
    const built = A.buildCanonicalDocument(document(), authority).document;
    expect(built).toMatchObject({
      canonical_schema: A.CANONICAL_SCHEMA,
      nda_id: authority.ndaId,
      version_id: authority.versionId,
      version_number: 1,
      parties: [
        { signer_id: authority.signers.a.id, party_ref: authority.signers.a.partyRef, role: "discloser" },
        { signer_id: authority.signers.b.id, party_ref: authority.signers.b.partyRef, role: "recipient" },
      ],
    });
    expect(built.clauses).toHaveLength(8);
    expect(built.parties[0].identity.age_years).toBe(35);
    expect(built.parties[1].identity.juristic).toMatchObject({
      authorized_signer: "Signer B", registration_office: "Bangkok Registry",
      certificate_date: "2026-08-01", power_of_attorney_date: "2026-08-02",
      address_number: "1", road: "Silom", subdistrict: "Suriyawong",
      district: "Bang Rak", province: "Bangkok",
    });
  });

  it("fails closed when flexible material contains signing evidence or secrets", () => {
    expect(() => A.buildCanonicalDocument(document({ material_options: { signature_image: "x" } }), authority)).toThrow(/forbidden_material_options/);
    expect(() => A.buildCanonicalDocument(document({ exceptions: { nested: { signing_token: "x" } } }), authority)).toThrow(/forbidden_exceptions/);
  });

  it("maps the actual generated and rendered NDA material into canonical fields", () => {
    for (const templateField of ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "intro", "closing"]) {
      expect(LEGACY_BACKEND).toContain(`${templateField}: \``);
    }
    for (const rendered of ["meta.date_th", "meta.intro", "meta.closing", "partyBlock(meta,'a'", "partyBlock(meta,'b'", "for(let i=1;i<=8;i++)"]) {
      expect(LEGACY_UI).toContain(rendered);
    }
    const built = A.buildCanonicalDocument(document(), authority).document;
    expect(built).toHaveProperty("document_intro");
    expect(built).toHaveProperty("document_closing");
    expect(built).toHaveProperty("place_of_execution");
    expect(built).toHaveProperty("display_date");
    expect(built).toHaveProperty("confidential_information_scope");
    expect(built).toHaveProperty("permitted_purpose");
    expect(built.clauses).toHaveLength(8);
  });

  it("hashes every presented individual and juristic identity value", () => {
    const base = A.buildCanonicalDocument(document(), authority).hash;
    for (const field of ["display_name", "national_id", "age_years", "address", "phone"]) {
      const a = { ...document().parties.a, [field]: field === "age_years" ? 36 : `Changed ${field}` };
      expect(A.buildCanonicalDocument(document({ parties: { ...document().parties, a } }), authority).hash).not.toBe(base);
    }
    for (const field of [
      "name", "registration_number", "authorized_signer", "registration_office",
      "certificate_date", "power_of_attorney_date", "address_number", "road",
      "subdistrict", "district", "province",
    ]) {
      const b = document().parties.b;
      const changed = { ...b, juristic: { ...b.juristic, [field]: `Changed ${field}` } };
      expect(A.buildCanonicalDocument(document({ parties: { ...document().parties, b: changed } }), authority).hash).not.toBe(base);
    }
  });
});

describe("NDA signing capability foundation", () => {
  it("issues high-entropy random material unrelated to row or signer identity", () => {
    const one = A.issueCapability(new Date("2026-08-04T00:00:00Z"), 3600);
    const two = A.issueCapability(new Date("2026-08-04T00:00:00Z"), 3600);
    expect(one.plaintext).not.toBe(two.plaintext);
    expect(Buffer.from(one.plaintext, "base64url")).toHaveLength(A.CAPABILITY_BYTES);
    expect(one.plaintext).not.toContain(authority.ndaId);
    expect(one.plaintext).not.toContain(authority.signers.a.id);
  });

  it("stores a one-way digest representation with explicit expiry", () => {
    const cap = A.issueCapability(new Date("2026-08-04T00:00:00Z"), 3600);
    expect(cap.digest).toBe(createHash("sha256").update(cap.plaintext).digest("hex"));
    expect(cap.digest).not.toContain(cap.plaintext);
    expect(cap.expiresAt).toBe("2026-08-04T01:00:00.000Z");
  });

  it("sends only digests, never plaintext capabilities, to persistence", async () => {
    const pkg = A.createAuthorityPackage({ document: document(), capability_ttl_seconds: 3600 });
    let persistedBody;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      persistedBody = JSON.parse(options.body);
      return { ok: true };
    }));
    await endpoint.persistAuthority(pkg);
    const serialized = JSON.stringify(persistedBody);
    expect(serialized).toContain(pkg.capA.digest);
    expect(serialized).toContain(pkg.capB.digest);
    expect(serialized).not.toContain(pkg.capA.plaintext);
    expect(serialized).not.toContain(pkg.capB.plaintext);
  });
});

describe("NDA authority API boundary", () => {
  function response() {
    return {
      headers: {}, statusCode: 0, body: null,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
  }

  it("uses fixed-length digest comparison for the authority key", () => {
    expect(A.secretMatches("correct horse", "correct horse")).toBe(true);
    expect(A.secretMatches("wrong", "correct horse")).toBe(false);
    expect(A.secretMatches("", "correct horse")).toBe(false);
  });

  it("rejects method, media type, and oversized bodies before persistence", async () => {
    const wrongMethod = response();
    await endpoint({ method: "GET", headers: {} }, wrongMethod);
    expect(wrongMethod.statusCode).toBe(405);

    const wrongType = response();
    await endpoint({ method: "POST", headers: { "content-type": "text/plain" } }, wrongType);
    expect(wrongType.statusCode).toBe(415);

    const tooLarge = response();
    await endpoint({
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(A.MAX_REQUEST_BYTES + 1) },
    }, tooLarge);
    expect(tooLarge.statusCode).toBe(413);
    for (const res of [wrongMethod, wrongType, tooLarge]) expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});

describe("NDA authority database contract", () => {
  it("binds signers and capabilities to the same NDA version with composite foreign keys", () => {
    expect(SQL).toMatch(/foreign key \(nda_id, version_id\)[\s\S]*nda_authority_versions\(nda_id, id\)/);
    expect(SQL).toMatch(/foreign key \(nda_id, version_id, signer_id\)[\s\S]*nda_authority_signers\(nda_id, version_id, id\)/);
    expect(SQL).toMatch(/immutable nda authority signer mapping/);
  });

  it("binds audit versions and signers to the event NDA and exact version", () => {
    const audit = SQL.slice(
      SQL.indexOf("create table if not exists public.nda_authority_audit_events"),
      SQL.indexOf("create index if not exists nda_authority_versions_nda_idx"),
    );
    expect(audit).toMatch(/foreign key \(nda_id, version_id\)[\s\S]*nda_authority_versions\(nda_id, id\)/);
    expect(audit).toMatch(/foreign key \(nda_id, version_id, signer_id\)[\s\S]*nda_authority_signers\(nda_id, version_id, id\)/);
    expect(audit).toMatch(/check \(signer_id is null or version_id is not null\)/);
  });

  it("allows only safe lifecycle invalidation and revokes capabilities atomically", () => {
    for (const transition of [["draft", "issued"], ["draft", "void"], ["issued", "void"], ["issued", "superseded"]]) {
      expect(A.isVersionTransitionAllowed(...transition)).toBe(true);
    }
    for (const transition of [["issued", "draft"], ["void", "issued"], ["superseded", "issued"], ["superseded", "void"]]) {
      expect(A.isVersionTransitionAllowed(...transition)).toBe(false);
    }
    expect(SQL).toMatch(/old\.lifecycle_status = 'issued'[\s\S]*new\.lifecycle_status not in \('void','superseded'\)/);
    expect(SQL).toMatch(/set status = 'revoked', revoked_at = clock_timestamp\(\)[\s\S]*status = 'active'/);
    expect(SQL).toMatch(/active capabilities must be revoked before invalidation/);
    expect(SQL).toMatch(/terminal nda authority version is immutable/);
    expect(SQL).toMatch(/nda_authority_audit_version_transition[\s\S]*version\.superseded/);
    expect(SQL).toMatch(/returning signer_id[\s\S]*'capability\.revoked'/);
    expect(SQL).toMatch(/id <> p_version_id[\s\S]*version_number > v\.version_number/);
  });

  it("persists canonical bytes and verifies their SHA-256 in the database", () => {
    expect(SQL).toMatch(/canonical_payload text not null/);
    expect(SQL).toMatch(/extensions\.digest\(convert_to\(canonical_payload, 'UTF8'\), 'sha256'\) = document_hash/);
    expect(SQL).toMatch(/nda authority version must be sequential/);
  });

  it("stores no plaintext capability column and represents expiry, revocation, and consumption", () => {
    const capabilityTable = SQL.slice(
      SQL.indexOf("create table if not exists public.nda_authority_capabilities"),
      SQL.indexOf("create table if not exists public.nda_authority_audit_events"),
    );
    expect(capabilityTable).toContain("capability_digest bytea");
    expect(capabilityTable).not.toMatch(/plaintext|raw_token|capability_token/);
    expect(capabilityTable).toMatch(/expires_at timestamptz not null/);
    expect(capabilityTable).toMatch(/revoked_at timestamptz/);
    expect(capabilityTable).toMatch(/consumed_at timestamptz/);
    expect(capabilityTable).toMatch(/\(status = 'consumed'\) = \(consumed_at is not null\)/);
    expect(capabilityTable).toMatch(/\(status = 'revoked'\) = \(revoked_at is not null\)/);
  });

  it("constrains required roles, signer order, SECURITY DEFINER ownership, and search paths", () => {
    expect(SQL).toMatch(/unique \(nda_id, version_id, signing_order\)/);
    expect(SQL).toMatch(/nda_authority_required_role_once[\s\S]*where signer_role in \('discloser','recipient'\)/);
    expect(SQL).toMatch(/count\(\*\)[\s\S]*role' = 'discloser'[\s\S]*<> 1/);
    expect(SQL).toMatch(/count\(\*\)[\s\S]*role' = 'recipient'[\s\S]*<> 1/);
    expect(SQL.match(/security definer\s+set search_path = public, pg_temp/g)).toHaveLength(2);
    expect(SQL.match(/owner to postgres/g)).toHaveLength(2);
    expect(SQL).toMatch(/revoke execute on function public\.nda_authority_guard_version_update\(\) from public/);
  });

  it("requires canonical signer IDs, party references, and roles to match inserted signers", () => {
    expect(SQL).toMatch(/jsonb_array_elements\(p_canonical_document->'parties'\)[\s\S]*p->>'signer_id' = x->>'id'[\s\S]*p->>'party_ref' = x->>'party_ref'[\s\S]*p->>'role' = x->>'role'/);
  });

  it("gives anon and authenticated roles no table or RPC authority", () => {
    for (const table of ["contracts", "versions", "signers", "capabilities", "audit_events"]) {
      expect(SQL).toContain(`alter table public.nda_authority_${table} enable row level security`);
      expect(SQL).toContain(`revoke all on public.nda_authority_${table} from anon, authenticated, service_role`);
    }
    expect(SQL).toMatch(/revoke all on function[\s\S]*from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function[\s\S]*to service_role/);
  });

  it("keeps legacy NDA data explicitly non-authoritative", () => {
    expect(SQL).not.toMatch(/insert into public\.nda_contracts|alter table public\.nda_contracts/);
    expect(SQL).toContain("Legacy public.nda_contracts rows remain legacy");
  });
});

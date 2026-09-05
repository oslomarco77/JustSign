import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(resolve(ROOT, name), "utf8");

describe("NDA Workspace integration authority", () => {
  it("does not bind a draft NDA from browser-controlled row creation", () => {
    const source = read("index-nda.html");
    const lifecycle = source.slice(
      source.indexOf("async function ensureRow()"),
      source.indexOf("function partyPayload"),
    );

    expect(lifecycle).toContain("status:'draft'");
    expect(lifecycle).not.toMatch(/SignDeeWS\s*\.\s*bind\s*\(/);
  });

  it("keeps existing Sale and Rental draft handoff behavior unchanged", () => {
    expect(read("index-sale.html")).toMatch(/SignDeeWS\s*\.\s*bind\s*\(/);
    expect(read("index.html")).toMatch(/SignDeeWS\s*\.\s*bind\s*\(/);
  });

  it("does not add an NDA-only receiver or claim/redeem protocol", () => {
    const files = ["index-nda.html", "ws-link.js"];
    for (const file of files) {
      expect(read(file)).not.toMatch(/\/api\/(?:claim|redeem)|claim_code/i);
    }
  });
});

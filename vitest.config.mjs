import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = resolve(fileURLToPath(import.meta.url), "..");

/**
 * SD-403 — Vitest configuration for the e-Signature repository.
 *
 * Tests here verify that the GENERATED contract consumer
 * (`api/_esign_contract.generated.js`) behaves identically to the source of
 * truth in sign-dee. This repository never hand-maintains contract logic.
 *
 * Cache lives outside `node_modules`, which holds platform-specific binaries.
 * Vercel is unaffected: `vercel.json` sets `"installCommand": "echo skip"`,
 * so devDependencies are never installed for a deployment.
 */
export default defineConfig({
  cacheDir: resolve(dir, ".vitest-cache"),
  test: {
    environment: "node",
    include: ["tests/**/*.test.mjs"],
    exclude: ["node_modules/**", "_trash/**"],
    reporters: ["default"],
  },
});

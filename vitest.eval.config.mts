import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Evals call a real model: slow, paid, and not part of `npm test` or CI.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["evals/**/*.eval.ts"],
    testTimeout: 180_000,
    env: { TOOL_APPROVAL_SECRET: process.env.TOOL_APPROVAL_SECRET ?? "eval-approval-secret-000000000000000" },
  },
});

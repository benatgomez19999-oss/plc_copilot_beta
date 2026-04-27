import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@plccopilot/codegen-codesys': fileURLToPath(
        new URL('../codegen-codesys/src/index.ts', import.meta.url),
      ),
      '@plccopilot/codegen-core': fileURLToPath(
        new URL('../codegen-core/src/index.ts', import.meta.url),
      ),
      '@plccopilot/codegen-rockwell': fileURLToPath(
        new URL('../codegen-rockwell/src/index.ts', import.meta.url),
      ),
      '@plccopilot/codegen-siemens': fileURLToPath(
        new URL('../codegen-siemens/src/index.ts', import.meta.url),
      ),
      '@plccopilot/pir': fileURLToPath(
        new URL('../pir/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    // Sprint 38 — the dispatcher tests `await import('../src/cli.js')`
    // which lazy-loads every codegen package barrel. Under
    // `pnpm -r test` the workspace runs packages in parallel and
    // the cold dynamic-import path can exceed the 5s default on
    // contended I/O. Logic itself is sub-50ms; the timeout only
    // covers the cold-load tail. Raised to 15s so `pnpm -r test`
    // is deterministic without inflating the dev-loop iteration
    // time when run in isolation.
    testTimeout: 15000,
  },
});

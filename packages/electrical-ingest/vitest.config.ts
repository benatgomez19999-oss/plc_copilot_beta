import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Workspace alias — same shape as every other package's vitest.config.ts.
// Sprint 76 added @plccopilot/pir as a runtime dep so the PIR builder can
// import types + the validator; the alias points at the source so tests
// don't depend on a built dist.
export default defineConfig({
  resolve: {
    alias: {
      '@plccopilot/pir': fileURLToPath(
        new URL('../pir/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});

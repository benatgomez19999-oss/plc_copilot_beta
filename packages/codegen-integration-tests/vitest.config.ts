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
  },
});

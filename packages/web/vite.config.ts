/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Workspace aliases — same shape as every other package's vitest.config.ts.
// Vite uses these for both `vite dev` (browser bundling) and `vitest run`
// (Node-side unit tests).
const aliases = {
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
  '@plccopilot/electrical-ingest': fileURLToPath(
    new URL('../electrical-ingest/src/index.ts', import.meta.url),
  ),
  '@plccopilot/pir': fileURLToPath(
    new URL('../pir/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: aliases },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});

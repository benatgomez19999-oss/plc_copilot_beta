/**
 * Sprint 53 — build-only ambient shims for sibling workspace packages.
 *
 * Why this file exists:
 *   `tsc -p tsconfig.build.json` would otherwise follow the `paths`
 *   mappings from the base tsconfig back into sibling packages'
 *   `src/*.ts` and report TS6059 ("file is not under rootDir").
 *
 * Strategy:
 *   The build config overrides `paths` to send every `@plccopilot/*`
 *   import here. The shims declare each named export as `any` for
 *   both type and value position so `import { type Project }` keeps
 *   compiling. Real type checking is covered by `pnpm typecheck`,
 *   which uses the regular `tsconfig.json` (paths intact) and emits
 *   nothing — the build is purely about emitting `dist/*.js`.
 *
 * Runtime resolution is unaffected: when Node loads `dist/index.js`,
 * pnpm's symlink at `node_modules/@plccopilot/<pkg>` points at the
 * real package, whose `main: ./src/index.ts` is loaded via Node's
 * built-in TypeScript stripping.
 *
 * If the CLI grows new cross-package imports, add the symbol below
 * (or the build will fail with a clear "module has no exported
 * member" error).
 */

declare module '@plccopilot/codegen-core' {
  export const stableJson: any;
  export const formatSerializedCompilerError: any;
  export const serializeCompilerError: any;
  export type SerializedCompilerError = any;
  export type GeneratedArtifact = any;
}

declare module '@plccopilot/pir' {
  export const validate: any;
  export const ProjectSchema: any;
  export type Project = any;
  export type Issue = any;
  export type ValidationReport = any;
  export type Machine = any;
}

declare module '@plccopilot/codegen-codesys' {
  export const generateCodesysProject: any;
}

declare module '@plccopilot/codegen-rockwell' {
  export const generateRockwellProject: any;
}

declare module '@plccopilot/codegen-siemens' {
  export const generateSiemensProject: any;
}

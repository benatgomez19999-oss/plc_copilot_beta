# Adding a new backend

This cookbook walks through creating a new codegen backend (e.g. Beckhoff
TwinCAT, B&R Automation Studio, Schneider EcoStruxure). Follow it in
order; each step is enforced by tests in the next.

The two existing experimental backends (`@plccopilot/codegen-codesys`,
`@plccopilot/codegen-rockwell`) are the reference implementations. Skim
them before starting.

## 1. Scaffold the package

```sh
mkdir -p packages/codegen-<vendor>/src/{renderers,generators}
mkdir -p packages/codegen-<vendor>/tests
```

### `packages/codegen-<vendor>/package.json`

```json
{
  "name": "@plccopilot/codegen-<vendor>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@plccopilot/codegen-core": "workspace:*",
    "@plccopilot/pir": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

**No dependency on any other backend.** The only allowed cross-package
import is `@plccopilot/codegen-core`.

### `packages/codegen-<vendor>/tsconfig.json` & `vitest.config.ts`

Copy from `packages/codegen-codesys/`. Update the package paths in
`tsconfig.paths` and the vitest aliases — both must include
`@plccopilot/codegen-core` and `@plccopilot/pir`.

## 2. Extend the `BackendId` union

In `packages/codegen-core/src/compiler/backend.ts`:

```ts
export type BackendId =
  | 'siemens' | 'codesys' | 'rockwell'
  | '<vendor>';

export const <VENDOR>: BackendId = '<vendor>';
```

The bare `'<vendor>'` literal is the only allowed leakage of your
backend name in core. The `no-backend-leakage` scan exempts it because
it lives in the BackendId definition.

## 3. Define naming + namespace map

`packages/codegen-<vendor>/src/naming.ts`:

```ts
import type { BackendNamespaceMap } from '@plccopilot/codegen-core';

export const <VENDOR>_DIR = '<vendor>';
export const <VENDOR>_MANIFEST_PATH = `${<VENDOR>_DIR}/manifest.json`;

/**
 * Canonical IR DB names → <vendor>-specific aliases. Every
 * vendor-specific namespace literal lives here, not in core.
 */
export const <VENDOR>_NAMESPACES: BackendNamespaceMap = Object.freeze({
  DB_Alarms: '…',          // e.g. 'GVL_Alarms', 'Alarms', 'AlarmTags'
  DB_Global_Params: '…',
  DB_Recipes: '…',
});
```

Pick aliases that match the target vendor's idiom. `DB_*` is the
canonical IR name; the alias is what you render.

## 4. Implement the renderer

`packages/codegen-<vendor>/src/renderers/<vendor>-st.ts` (or `.scl`,
`.st`, whatever the target uses):

```ts
import type {
  ExprIR, FunctionBlockIR, StmtIR, VarSectionIR,
} from '@plccopilot/codegen-core';
import {
  renderRef as renderRefCore,
  renderSymbol as renderSymbolCore,
} from '@plccopilot/codegen-core';
import { <VENDOR>_NAMESPACES } from '../naming.js';

// Pin the namespace map onto every render call so callers don't have to.
function renderRef(r: Parameters<typeof renderRefCore>[0]): string {
  return renderRefCore(r, '<vendor>', <VENDOR>_NAMESPACES);
}
function renderSymbol(s: Parameters<typeof renderSymbolCore>[0]): string {
  return renderSymbolCore(s, '<vendor>', <VENDOR>_NAMESPACES);
}

export function renderExpr<Vendor>(e: ExprIR): string { … }
export function renderStmt<Vendor>(stmt: StmtIR, level: number): string[] { … }
export function renderVarSection<Vendor>(s: VarSectionIR, level: number): string[] { … }
export function renderFunctionBlock<Vendor>(fb: FunctionBlockIR): string { … }
```

Mirror the structure of `codegen-codesys/src/renderers/codesys-st.ts`.
Pay attention to:

- `EdgeRef` — Codesys renders `<name>.Q`; Rockwell renders bare
  one-shot bit. Pick what matches your target.
- `TonCall` — IEC `TON_x(IN := …, PT := T#…MS);` works for IEC backends.
  Logix-style timers need a different shape (see Rockwell for a
  pseudo-IEC POC + diagnostic).
- `Raw` IR — falls back to text. Mirror the namespace remapping in a
  `<vendor>SiemensText(s)` helper.

UDT renderer in `renderers/types.ts`, GVL/DB renderer in
`renderers/data-blocks.ts` — both consume the canonical IR shapes from
`@plccopilot/codegen-core`.

## 5. Implement the manifest

`packages/codegen-<vendor>/src/generators/<vendor>-manifest.ts`:

```ts
import {
  basename,
  stableJson,
  type GeneratedArtifact,
  type ProgramIR,
} from '@plccopilot/codegen-core';
import { <VENDOR>_MANIFEST_PATH } from '../naming.js';

export { <VENDOR>_MANIFEST_PATH };

export function generate<Vendor>Manifest(
  program: ProgramIR,
  artifactPaths: readonly string[],
): GeneratedArtifact {
  const data: Record<string, unknown> = {
    generator: '@plccopilot/codegen-<vendor>',
    backend: '<vendor>',
    experimental: true,                 // until promoted to production
    version: '0.1.0',
    pir_version: program.pirVersion,
    project_id: program.projectId,
    project_name: program.projectName,
    target: { vendor: '<vendor_runtime>', /* ide_version: null */ },
    features: { /* snake_case flatten of program.features */ },
    artifacts: artifactPaths.map(basename),
    generated_at: program.manifest.generatedAt,
  };
  if (program.features.emitDiagnosticsInManifest) {
    data.compiler_diagnostics = program.manifest.compilerDiagnostics.map(/* … */);
  }
  return { path: <VENDOR>_MANIFEST_PATH, kind: 'json', content: stableJson(data) };
}
```

`stableJson` guarantees byte-identical output across runs.

## 6. Implement the project façade

`packages/codegen-<vendor>/src/generators/<vendor>-project.ts`:

```ts
import type { Project } from '@plccopilot/pir';
import {
  compileProject,
  type CompileProjectOptions,
  type GeneratedArtifact,
  type ProgramIR,
} from '@plccopilot/codegen-core';
import { renderFunctionBlock<Vendor> } from '../renderers/<vendor>-st.js';
import { renderTypeArtifact<Vendor> } from '../renderers/types.js';
import { renderDataBlock<Vendor> } from '../renderers/data-blocks.js';
import { <VENDOR>_DIR } from '../naming.js';
import { generate<Vendor>Manifest } from './<vendor>-manifest.js';

export interface Generate<Vendor>Options extends CompileProjectOptions {}

export function generate<Vendor>Project(
  project: Project,
  options?: Generate<Vendor>Options,
): GeneratedArtifact[] {
  const program = compileProject(project, options);
  return renderProgramArtifacts<Vendor>(program);
}

export function renderProgramArtifacts<Vendor>(
  program: ProgramIR,
): GeneratedArtifact[] {
  const out: GeneratedArtifact[] = [];
  for (const fb of program.blocks) {
    out.push({
      path: `${<VENDOR>_DIR}/${fb.name}.<ext>`,
      kind: '<kind>',
      content: renderFunctionBlock<Vendor>(fb),
    });
  }
  for (const t of program.typeArtifacts) {
    const r = renderTypeArtifact<Vendor>(t);
    out.push({ path: r.path, kind: '<kind>', content: r.content });
  }
  for (const db of program.dataBlocks) {
    const r = renderDataBlock<Vendor>(db);
    out.push({ path: r.path, kind: '<kind>', content: r.content });
  }
  out.push(generate<Vendor>Manifest(program, out.map((a) => a.path)));
  return out;
}
```

## 7. Public API barrel

`packages/codegen-<vendor>/src/index.ts`:

```ts
export {
  generate<Vendor>Project,
  renderProgramArtifacts<Vendor>,
  type Generate<Vendor>Options,
} from './generators/<vendor>-project.js';
export {
  generate<Vendor>Manifest,
  <VENDOR>_MANIFEST_PATH,
} from './generators/<vendor>-manifest.js';
export {
  renderFunctionBlock<Vendor>,
  renderExpr<Vendor>,
  renderStmt<Vendor>,
  renderVarSection<Vendor>,
} from './renderers/<vendor>-st.js';
export { renderTypeArtifact<Vendor> } from './renderers/types.js';
export { renderDataBlock<Vendor> } from './renderers/data-blocks.js';
export { <VENDOR>_DIR, <VENDOR>_NAMESPACES } from './naming.js';
```

## 8. Tests

Add at minimum:

### `tests/<vendor>-renderer.spec.ts`

Unit-test each renderer function with built-up `FunctionBlockIR` /
`StmtIR` / `ExprIR` fixtures. Assert exact strings for the contractual
landmarks (FB envelope, namespace prefixes, edge / timer rendering).

### `tests/<vendor>-project.spec.ts`

End-to-end: `generate<Vendor>Project(weldlineFixture, CLOCK)` →
canonical artifact set. Assert:

- expected artifact paths in expected emission order
- `manifest.json` content has `backend: '<vendor>'`, correct generator
  string, full `compiler_diagnostics` array
- station diagnostics (e.g. `TIMEOUT_NO_AUTO_TRANSITION`) attach to
  station FB artifacts
- determinism across two independent runs (`expect(a).toEqual(b)`)

### `tests/<vendor>-backend-paths.spec.ts`

Pin every artifact path under `<vendor>/`. Confirm no `siemens/`,
`codesys/`, or other backend prefix leaks. Confirm no `.scl` extension
in a non-Siemens backend, etc.

### Integration test entry in `codegen-integration-tests`

Add the new backend to
`packages/codegen-integration-tests/tests/backend-equivalence.spec.ts`:
- station FB count matches every other backend
- alarm set matches
- diagnostics inherited from `compileProject` are preserved
- two-run determinism

And to `tests/no-siemens-leakage.spec.ts` (cross-backend output scan):
- `<vendor>` artifacts contain no Siemens-style PLC tags (`"name"`,
  `#name`), no `"DB_Alarms"`, no other backend's namespace literals.

Don't forget to add the workspace dep:

```json
// packages/codegen-integration-tests/package.json
"dependencies": {
  "@plccopilot/codegen-<vendor>": "workspace:*",
  …
}
```

## 9. Documentation

- Update `README.md` "Backend status" with the new backend.
- Add a paragraph in `docs/architecture.md` if the backend introduces a
  novel transformation (e.g., one-shot edge bits in Rockwell, AOI
  packaging, etc.).
- If the backend has known POC limitations, define dedicated
  diagnostic codes (`<VENDOR>_EXPERIMENTAL_BACKEND`,
  `<VENDOR>_NO_<X>_EXPORT`, …) in
  `@plccopilot/codegen-core/compiler/diagnostics.ts` (the only place
  `DiagnosticCode` lives) and emit them from the backend's artifact
  renderer.

## Checklist before merging

- [ ] `pnpm --filter @plccopilot/codegen-<vendor> typecheck` passes
- [ ] `pnpm --filter @plccopilot/codegen-<vendor> test` passes
- [ ] `pnpm --filter @plccopilot/codegen-integration-tests test` passes
- [ ] `pnpm --filter @plccopilot/codegen-core test` still passes
      (in particular, `no-backend-leakage`)
- [ ] No `import` from another backend
- [ ] Renderer is namespace-map-driven (no `'GVL_Alarms'` /
      `'Alarms.set_'` / etc. literals outside `naming.ts`)
- [ ] Output is byte-deterministic across two runs
- [ ] Manifest carries `backend: '<vendor>'` and `experimental` flag
- [ ] README + diagnostics list updated

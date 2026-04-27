import { describe, expect, it } from 'vitest';

/**
 * Post core-extraction backwards-compatibility smoke. Pre-existing consumers
 * imported these symbols from `@plccopilot/codegen-siemens`. Even though the
 * canonical implementations now live in `@plccopilot/codegen-core`, the
 * Siemens package re-exports them so external import paths keep working.
 *
 * If anything below stops resolving, the public API has regressed.
 */
describe('codegen-siemens — backward-compatible re-exports', () => {
  it('still exposes the Siemens-side façades', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.generateSiemensProject).toBe('function');
    expect(typeof mod.generateCodesysProject).toBe('function');
    expect(typeof mod.generateRockwellProject).toBe('function');
    expect(typeof mod.renderProgramArtifacts).toBe('function');
    expect(typeof mod.renderProgramArtifactsCodesys).toBe('function');
    expect(typeof mod.renderProgramArtifactsRockwell).toBe('function');
  });

  it('still re-exports core compiler-pipeline symbols', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.compileProject).toBe('function');
    expect(typeof mod.serializeProgramIR).toBe('function');
    expect(typeof mod.resolveFeatures).toBe('function');
    expect(typeof mod.dbNamespaceFor).toBe('function');
    expect(typeof mod.renderRef).toBe('function');
    expect(typeof mod.renderSymbol).toBe('function');
    expect(typeof mod.ref).toBe('object');
  });

  it('still re-exports CodegenError and diagnostic helpers', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.CodegenError).toBe('function');
    expect(typeof mod.diag).toBe('function');
    expect(typeof mod.sortDiagnostics).toBe('function');
    expect(typeof mod.dedupDiagnostics).toBe('function');
  });

  it('legacy deep imports through shimmed paths still resolve', async () => {
    const diag = await import('../src/compiler/diagnostics.js');
    expect(typeof diag.diag).toBe('function');
    expect(typeof diag.hasErrors).toBe('function');

    const ir = await import('../src/compiler/ir/builder.js');
    expect(typeof ir.ir).toBe('object');
    expect(typeof ir.ref).toBe('object');

    const symbols = await import('../src/compiler/symbols/render-symbol.js');
    expect(typeof symbols.renderRef).toBe('function');
    expect(typeof symbols.renderSymbol).toBe('function');

    const program = await import('../src/compiler/program/program.js');
    // Type-only barrel — the runtime module re-exports core's type aliases.
    expect(typeof program).toBe('object');
  });
});

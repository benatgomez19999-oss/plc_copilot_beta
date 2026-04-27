import { describe, expect, it } from 'vitest';

/**
 * Smoke test: every documented public symbol is reachable through the
 * `@plccopilot/codegen-core` barrel and has the expected runtime kind.
 * Drift catches accidental removals when downstream backends are extracted.
 */
describe('codegen-core public API surface', () => {
  it('exports the diagnostic helpers', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.diag).toBe('function');
    expect(typeof mod.hasErrors).toBe('function');
    expect(typeof mod.firstError).toBe('function');
    expect(typeof mod.makeDiagnostic).toBe('function');
    expect(typeof mod.toArtifactDiagnostic).toBe('function');
    expect(typeof mod.formatDiagnostic).toBe('function');
    expect(typeof mod.sortDiagnostics).toBe('function');
    expect(typeof mod.dedupDiagnostics).toBe('function');
  });

  it('exports the IR builders', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.ir).toBe('object');
    expect(typeof mod.ref).toBe('object');
    expect(typeof mod.lowerExpression).toBe('function');
    expect(typeof mod.astToIr).toBe('function');
  });

  it('exports the symbol layer', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.renderSymbol).toBe('function');
    expect(typeof mod.renderRef).toBe('function');
    expect(typeof mod.renderStorage).toBe('function');
    expect(typeof mod.storageToRef).toBe('function');
    expect(typeof mod.dbNamespaceFor).toBe('function');
    expect(typeof mod.SymbolTable).toBe('function');
    expect(typeof mod.buildSymbolTable).toBe('function');
  });

  it('exports the lowering passes', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.lowerStation).toBe('function');
    expect(typeof mod.lowerSequence).toBe('function');
    expect(typeof mod.lowerStateActivity).toBe('function');
    expect(typeof mod.lowerInterlocks).toBe('function');
    expect(typeof mod.lowerOutputWiring).toBe('function');
    expect(typeof mod.lowerTimerBlock).toBe('function');
    expect(typeof mod.lowerEdgeTickBlock).toBe('function');
    expect(typeof mod.scanStation).toBe('function');
    expect(typeof mod.EdgeRegistry).toBe('function');
  });

  it('exports the program IR builders + serialize', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.buildEquipmentTypesIR).toBe('function');
    expect(typeof mod.buildDbAlarmsIR).toBe('function');
    expect(typeof mod.buildDbParamsIR).toBe('function');
    expect(typeof mod.buildDbRecipesIR).toBe('function');
    expect(typeof mod.serializeProgramIR).toBe('function');
    expect(typeof mod.canonicalTypeName).toBe('function');
    expect(typeof mod.codesysTypeName).toBe('function');
  });

  it('keeps `siemensTypeName` as a deprecated alias for `canonicalTypeName`', async () => {
    const mod = await import('../src/index.js');
    // Same identity (exported as a const alias).
    expect(mod.siemensTypeName).toBe(mod.canonicalTypeName);
    expect(mod.canonicalTypeName('pneumatic_cylinder_2pos')).toBe(
      'UDT_Cylinder2Pos',
    );
    expect(mod.siemensTypeName('motor_simple')).toBe('UDT_MotorSimple');
    expect(mod.canonicalTypeName('sensor_discrete')).toBeNull();
  });

  it('exports the expression layer', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.parseExpression).toBe('function');
    expect(typeof mod.checkExpression).toBe('function');
    expect(typeof mod.lex).toBe('function');
    expect(typeof mod.prettyPrint).toBe('function');
  });

  it('exports CodegenError + naming helpers', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.CodegenError).toBe('function');
    expect(Array.isArray(mod.CODEGEN_ERROR_CODES)).toBe(true);
    expect(typeof mod.toPascalCase).toBe('function');
    expect(typeof mod.sanitizeSymbol).toBe('function');
    expect(typeof mod.basename).toBe('function');
  });

  it('exposes BackendId constants', async () => {
    const mod = await import('../src/index.js');
    expect(mod.SIEMENS).toBe('siemens');
    expect(mod.CODESYS).toBe('codesys');
    expect(mod.ROCKWELL).toBe('rockwell');
  });
});

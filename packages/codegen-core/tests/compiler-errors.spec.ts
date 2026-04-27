import { describe, expect, it } from 'vitest';
import {
  CodegenError,
  formatSerializedCompilerError,
  serializeCompilerError,
} from '../src/index.js';

describe('serializeCompilerError — CodegenError', () => {
  it('preserves code + message + name', () => {
    const e = new CodegenError('UNKNOWN_PARAMETER', 'param ghost not found');
    const s = serializeCompilerError(e);
    expect(s.name).toBe('CodegenError');
    expect(s.code).toBe('UNKNOWN_PARAMETER');
    expect(s.message).toBe('param ghost not found');
  });

  it('preserves the legacy `path` string third arg', () => {
    const e = new CodegenError('UNKNOWN_IO', 'missing IO', 'machines[0]');
    const s = serializeCompilerError(e);
    expect(s.path).toBe('machines[0]');
  });

  it('preserves the new details bag (path/stationId/symbol/hint)', () => {
    const e = new CodegenError('UNKNOWN_PARAMETER', 'm', {
      path: 'machines[0].recipes[0].values.p_x',
      stationId: 'st_load',
      symbol: 'p_x',
      hint: 'add the parameter or remove the recipe entry',
    });
    const s = serializeCompilerError(e);
    expect(s.path).toBe('machines[0].recipes[0].values.p_x');
    expect(s.stationId).toBe('st_load');
    expect(s.symbol).toBe('p_x');
    expect(s.hint).toBe('add the parameter or remove the recipe entry');
  });

  it('summarises Error cause attached via the details bag', () => {
    const inner = new Error('ENOENT: no such file');
    const e = new CodegenError('INTERNAL_ERROR', 'compile failed', {
      cause: inner,
    });
    const s = serializeCompilerError(e);
    expect(s.cause).toBe('ENOENT: no such file');
  });

  it('omits stack by default and includes it on opt-in', () => {
    const e = new CodegenError('NO_MACHINE', 'no machine');
    expect(serializeCompilerError(e).stack).toBeUndefined();
    const withStack = serializeCompilerError(e, { includeStack: true });
    expect(typeof withStack.stack).toBe('string');
    expect(withStack.stack!.length).toBeGreaterThan(0);
  });
});

describe('serializeCompilerError — generic errors', () => {
  it('handles plain Error subclasses', () => {
    const s = serializeCompilerError(new TypeError('bad arg'));
    expect(s.name).toBe('TypeError');
    expect(s.message).toBe('bad arg');
    expect(s.code).toBeUndefined();
  });

  it('summarises Error.cause on plain errors', () => {
    const inner = new Error('inner');
    const e = new Error('outer');
    (e as { cause?: unknown }).cause = inner;
    const s = serializeCompilerError(e);
    expect(s.cause).toBe('inner');
  });

  it('handles string throws', () => {
    const s = serializeCompilerError('boom');
    expect(s.name).toBe('Error');
    expect(s.message).toBe('boom');
  });

  it('handles null / undefined / number throws gracefully', () => {
    expect(serializeCompilerError(null).message).toBe('null');
    expect(serializeCompilerError(undefined).message).toBe('undefined');
    expect(serializeCompilerError(42).message).toBe('42');
  });

  it('does not throw on circular objects', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => serializeCompilerError(a)).not.toThrow();
    const s = serializeCompilerError(a);
    expect(typeof s.message).toBe('string');
  });

  it('does not throw when toString is hostile', () => {
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(() => serializeCompilerError(hostile)).not.toThrow();
  });
});

describe('formatSerializedCompilerError', () => {
  it('renders [CODE] message when code is present', () => {
    const out = formatSerializedCompilerError({
      name: 'CodegenError',
      code: 'UNKNOWN_PARAMETER',
      message:
        'Recipe "r_default" references unknown parameter "p_missing".',
    });
    expect(out).toBe(
      '[UNKNOWN_PARAMETER] Recipe "r_default" references unknown parameter "p_missing".',
    );
  });

  it('falls back to Name: message without code', () => {
    expect(
      formatSerializedCompilerError({ name: 'TypeError', message: 'bad arg' }),
    ).toBe('TypeError: bad arg');
  });

  it('appends path / station / symbol metadata grouped in parens', () => {
    const out = formatSerializedCompilerError({
      name: 'CodegenError',
      code: 'UNKNOWN_IO',
      message: 'missing IO',
      path: 'machines[0]',
      stationId: 'st_load',
      symbol: 'sen_part',
    });
    expect(out).toBe(
      '[UNKNOWN_IO] missing IO (path: machines[0], station: st_load, symbol: sen_part)',
    );
  });

  it('appends Hint: when hint is present', () => {
    const out = formatSerializedCompilerError({
      name: 'CodegenError',
      code: 'UNKNOWN_PARAMETER',
      message: 'msg',
      hint: 'Define the parameter or remove the recipe entry.',
    });
    expect(out).toBe(
      '[UNKNOWN_PARAMETER] msg Hint: Define the parameter or remove the recipe entry.',
    );
  });

  it('appends Cause: when cause is present', () => {
    const out = formatSerializedCompilerError({
      name: 'CodegenError',
      code: 'INTERNAL_ERROR',
      message: 'compile failed',
      cause: 'ENOENT',
    });
    expect(out).toBe('[INTERNAL_ERROR] compile failed Cause: ENOENT');
  });

  it('combines all sections in a single line', () => {
    const out = formatSerializedCompilerError({
      name: 'CodegenError',
      code: 'UNKNOWN_PARAMETER',
      message: 'Recipe references unknown parameter.',
      path: 'machines[0].recipes[0].values.p_x',
      symbol: 'p_x',
      hint: 'Define the parameter or remove the recipe entry.',
    });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('[UNKNOWN_PARAMETER]');
    expect(out).toContain('(path: machines[0].recipes[0].values.p_x, symbol: p_x)');
    expect(out).toContain('Hint: Define the parameter or remove the recipe entry.');
  });

  it('appends stack on subsequent lines when present', () => {
    const out = formatSerializedCompilerError({
      name: 'CodegenError',
      code: 'X',
      message: 'm',
      stack: 'Error: m\n    at foo (file.ts:1:1)',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('[X] m');
    expect(lines[1]).toBe('Error: m');
    expect(lines[2]).toBe('    at foo (file.ts:1:1)');
  });

  it('renders compactly when only name + message are set', () => {
    expect(
      formatSerializedCompilerError({ name: 'Error', message: 'boom' }),
    ).toBe('Error: boom');
  });
});

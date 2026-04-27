import { describe, expect, it, vi } from 'vitest';
import {
  registerPlcLanguages,
  type MonacoLanguageHost,
} from '../src/utils/monaco-languages.js';

/**
 * Build a structural mock that satisfies `MonacoLanguageHost`. We never
 * import `monaco-editor` in unit tests — registerPlcLanguages was designed
 * around this thin interface so the test stays in Node.
 */
function makeMockMonaco(): MonacoLanguageHost & {
  registerSpy: ReturnType<typeof vi.fn>;
  tokensSpy: ReturnType<typeof vi.fn>;
  configSpy: ReturnType<typeof vi.fn>;
} {
  const registerSpy = vi.fn();
  const tokensSpy = vi.fn();
  const configSpy = vi.fn();
  return {
    registerSpy,
    tokensSpy,
    configSpy,
    languages: {
      register: registerSpy,
      setMonarchTokensProvider: tokensSpy,
      setLanguageConfiguration: configSpy,
    },
  };
}

describe('registerPlcLanguages — language registration', () => {
  it('registers `scl` with .scl extension and human-readable aliases', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    expect(m.registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'scl',
        extensions: expect.arrayContaining(['.scl']),
        aliases: expect.arrayContaining(['SCL']),
      }),
    );
  });

  it('registers `structured-text` with .st extension', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    expect(m.registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'structured-text',
        extensions: expect.arrayContaining(['.st']),
      }),
    );
  });

  it('registers exactly two languages', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    expect(m.registerSpy).toHaveBeenCalledTimes(2);
  });
});

describe('registerPlcLanguages — Monarch tokens provider', () => {
  it('calls setMonarchTokensProvider for `scl` with a non-empty definition', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    const sclCall = m.tokensSpy.mock.calls.find(
      (args) => args[0] === 'scl',
    );
    expect(sclCall).toBeDefined();
    const def = sclCall![1] as { keywords: string[]; tokenizer: { root: unknown[] } };
    expect(Array.isArray(def.keywords)).toBe(true);
    expect(def.keywords.length).toBeGreaterThan(10);
    expect(def.tokenizer.root.length).toBeGreaterThan(0);
  });

  it('calls setMonarchTokensProvider for `structured-text`', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    expect(m.tokensSpy).toHaveBeenCalledWith(
      'structured-text',
      expect.any(Object),
    );
  });

  it('keyword set covers SCL/ST envelope and control-flow keywords', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    const def = m.tokensSpy.mock.calls[0]![1] as { keywords: string[] };
    for (const kw of [
      'FUNCTION_BLOCK',
      'END_FUNCTION_BLOCK',
      'DATA_BLOCK',
      'TYPE',
      'VAR',
      'END_VAR',
      'IF',
      'THEN',
      'CASE',
      'OF',
      'TON',
      'R_TRIG',
      'F_TRIG',
      'TRUE',
      'FALSE',
    ]) {
      expect(def.keywords).toContain(kw);
    }
  });
});

describe('registerPlcLanguages — language configuration', () => {
  it('sets block + line comment markers on `scl`', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    const sclCall = m.configSpy.mock.calls.find(
      (args) => args[0] === 'scl',
    );
    expect(sclCall).toBeDefined();
    const config = sclCall![1] as {
      comments: { lineComment: string; blockComment: [string, string] };
    };
    expect(config.comments.lineComment).toBe('//');
    expect(config.comments.blockComment).toEqual(['(*', '*)']);
  });

  it('sets the same configuration on `structured-text`', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    expect(m.configSpy).toHaveBeenCalledWith(
      'structured-text',
      expect.objectContaining({
        comments: expect.objectContaining({
          blockComment: ['(*', '*)'],
        }),
      }),
    );
  });
});

describe('registerPlcLanguages — robustness', () => {
  it('does not throw on repeat invocation', () => {
    const m = makeMockMonaco();
    registerPlcLanguages(m);
    expect(() => registerPlcLanguages(m)).not.toThrow();
  });

  it('does not throw when only the minimal API is implemented', () => {
    // Only the three methods we use are required.
    const minimal: MonacoLanguageHost = {
      languages: {
        register: () => undefined,
        setMonarchTokensProvider: () => undefined,
        setLanguageConfiguration: () => undefined,
      },
    };
    expect(() => registerPlcLanguages(minimal)).not.toThrow();
  });
});

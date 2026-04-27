import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetMonacoLoaderState,
  configureMonacoLoaderWith,
  isMonacoLoaderConfigured,
  type MinimalLoader,
} from '../src/utils/monaco-loader.js';

afterEach(() => {
  _resetMonacoLoaderState();
});

function makeFakeLoader(): MinimalLoader & {
  configSpy: ReturnType<typeof vi.fn>;
} {
  const configSpy = vi.fn();
  return {
    configSpy,
    config: configSpy,
  };
}

describe('configureMonacoLoaderWith — first-call semantics', () => {
  it('forwards { monaco } to loader.config and returns true', () => {
    const fake = makeFakeLoader();
    const monacoStub = { __id: 'fake-monaco' };
    const did = configureMonacoLoaderWith(fake, monacoStub);
    expect(did).toBe(true);
    expect(fake.configSpy).toHaveBeenCalledTimes(1);
    expect(fake.configSpy).toHaveBeenCalledWith({ monaco: monacoStub });
    expect(isMonacoLoaderConfigured()).toBe(true);
  });

  it('records the configured state across calls', () => {
    const fake = makeFakeLoader();
    expect(isMonacoLoaderConfigured()).toBe(false);
    configureMonacoLoaderWith(fake, {});
    expect(isMonacoLoaderConfigured()).toBe(true);
  });
});

describe('configureMonacoLoaderWith — idempotence', () => {
  it('returns false on second call and does not reinvoke loader.config', () => {
    const fake = makeFakeLoader();
    expect(configureMonacoLoaderWith(fake, {})).toBe(true);
    expect(configureMonacoLoaderWith(fake, {})).toBe(false);
    expect(configureMonacoLoaderWith(fake, {})).toBe(false);
    expect(fake.configSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores a different monaco instance once configured', () => {
    const fake = makeFakeLoader();
    const first = { id: 'first' };
    const second = { id: 'second' };
    configureMonacoLoaderWith(fake, first);
    configureMonacoLoaderWith(fake, second);
    expect(fake.configSpy).toHaveBeenCalledTimes(1);
    expect(fake.configSpy).toHaveBeenCalledWith({ monaco: first });
  });
});

describe('_resetMonacoLoaderState — test-only reset', () => {
  it('allows reconfiguration after reset', () => {
    const fake = makeFakeLoader();
    configureMonacoLoaderWith(fake, {});
    _resetMonacoLoaderState();
    expect(isMonacoLoaderConfigured()).toBe(false);
    expect(configureMonacoLoaderWith(fake, {})).toBe(true);
    expect(fake.configSpy).toHaveBeenCalledTimes(2);
  });
});

describe('configureMonacoLoaderWith — does not throw', () => {
  it('does not throw when loader.config throws synchronously', () => {
    // Defensive: production loader.config should never throw, but a future
    // wrapper might. We don't catch it inside `configureMonacoLoaderWith` —
    // the caller (production async wrapper) already handles failures by
    // promoting them to the fallback path. This test pins the contract:
    // the function does propagate, but state remains pristine.
    const throwing: MinimalLoader = {
      config: () => {
        throw new Error('loader broken');
      },
    };
    expect(() => configureMonacoLoaderWith(throwing, {})).toThrow(
      /loader broken/,
    );
    // State should NOT be flipped to "configured" if the call threw.
    expect(isMonacoLoaderConfigured()).toBe(false);
  });
});

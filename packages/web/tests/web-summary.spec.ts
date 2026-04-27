import { describe, expect, it } from 'vitest';
import { stableJson } from '@plccopilot/codegen-core';
import {
  buildWebZipSummary,
  type WebZipSummary,
} from '../src/utils/web-summary.js';

const FIXED_TS = '2026-04-26T10:00:00.000Z';

describe('buildWebZipSummary', () => {
  it('produces the deterministic shape for siemens with a fixed timestamp', () => {
    const summary = buildWebZipSummary({
      backend: 'siemens',
      artifactCount: 3,
      diagnostics: { errors: 1, warnings: 2, info: 3 },
      generatedAt: FIXED_TS,
    });
    expect(summary).toEqual({
      backend: 'siemens',
      artifactCount: 3,
      errors: 1,
      warnings: 2,
      info: 3,
      generated_at: FIXED_TS,
    });
  });

  it('supports backend "all"', () => {
    const summary = buildWebZipSummary({
      backend: 'all',
      artifactCount: 27,
      diagnostics: { errors: 0, warnings: 5, info: 10 },
      generatedAt: FIXED_TS,
    });
    expect(summary.backend).toBe('all');
    expect(summary.artifactCount).toBe(27);
  });

  it.each(['siemens', 'codesys', 'rockwell', 'all'] as const)(
    'supports backend "%s"',
    (backend) => {
      const summary = buildWebZipSummary({
        backend,
        artifactCount: 1,
        diagnostics: { errors: 0, warnings: 0, info: 0 },
        generatedAt: FIXED_TS,
      });
      expect(summary.backend).toBe(backend);
    },
  );

  it('does not mutate the diagnostics input', () => {
    const diagnostics = { errors: 2, warnings: 1, info: 0 };
    Object.freeze(diagnostics);
    expect(() =>
      buildWebZipSummary({
        backend: 'siemens',
        artifactCount: 1,
        diagnostics,
        generatedAt: FIXED_TS,
      }),
    ).not.toThrow();
    expect(diagnostics).toEqual({ errors: 2, warnings: 1, info: 0 });
  });

  it('falls back to a fresh ISO timestamp when generatedAt is omitted', () => {
    const before = Date.now();
    const summary = buildWebZipSummary({
      backend: 'siemens',
      artifactCount: 0,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
    });
    const after = Date.now();
    expect(typeof summary.generated_at).toBe('string');
    const ts = Date.parse(summary.generated_at);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('copies artifact_count verbatim from input', () => {
    const summary = buildWebZipSummary({
      backend: 'siemens',
      artifactCount: 42,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      generatedAt: FIXED_TS,
    });
    expect(summary.artifactCount).toBe(42);
  });

  it('copies diagnostic counts to flat root fields', () => {
    const summary = buildWebZipSummary({
      backend: 'siemens',
      artifactCount: 1,
      diagnostics: { errors: 4, warnings: 5, info: 6 },
      generatedAt: FIXED_TS,
    });
    expect(summary.errors).toBe(4);
    expect(summary.warnings).toBe(5);
    expect(summary.info).toBe(6);
  });

  it('stableJson output is deterministic for fixed generatedAt', () => {
    const a = buildWebZipSummary({
      backend: 'rockwell',
      artifactCount: 9,
      diagnostics: { errors: 0, warnings: 1, info: 2 },
      generatedAt: FIXED_TS,
    });
    const b = buildWebZipSummary({
      backend: 'rockwell',
      artifactCount: 9,
      diagnostics: { errors: 0, warnings: 1, info: 2 },
      generatedAt: FIXED_TS,
    });
    expect(stableJson(a)).toBe(stableJson(b));
  });

  it('preserves the legacy FLAT shape — root errors/warnings/info, no `diagnostics` object', () => {
    // Sprint 51 contract decision: the shape inherited from the
    // pre-sprint-51 inline literal is preserved verbatim to avoid
    // breaking ZIP consumers.
    const summary = buildWebZipSummary({
      backend: 'siemens',
      artifactCount: 1,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      generatedAt: FIXED_TS,
    });
    expect('errors' in summary).toBe(true);
    expect('warnings' in summary).toBe(true);
    expect('info' in summary).toBe(true);
    expect(
      'diagnostics' in (summary as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  it('JSON.parse(stableJson(summary)) deep-equals the original', () => {
    const summary = buildWebZipSummary({
      backend: 'codesys',
      artifactCount: 5,
      diagnostics: { errors: 1, warnings: 2, info: 3 },
      generatedAt: FIXED_TS,
    });
    const round: WebZipSummary = JSON.parse(stableJson(summary));
    expect(round).toEqual(summary);
  });

  it('uses ISO date-time in generated_at when caller provides a Date.toISOString()', () => {
    const ts = new Date('2026-12-31T23:59:59.999Z').toISOString();
    const summary = buildWebZipSummary({
      backend: 'siemens',
      artifactCount: 0,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      generatedAt: ts,
    });
    expect(summary.generated_at).toBe(ts);
    expect(Number.isNaN(Date.parse(summary.generated_at))).toBe(false);
  });
});

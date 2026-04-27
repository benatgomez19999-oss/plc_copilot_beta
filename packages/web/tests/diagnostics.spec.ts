import { describe, expect, it } from 'vitest';
import type { ArtifactDiagnostic } from '@plccopilot/codegen-core';
import {
  aggregateDiagnostics,
  dedupeDiagnostics,
  sortDiagnosticsForDisplay,
} from '../src/utils/diagnostics.js';

const SAMPLE: ArtifactDiagnostic[] = [
  {
    code: 'TIMEOUT_NO_AUTO_TRANSITION',
    severity: 'info',
    message: 'timeout has no auto transition',
    stationId: 'st_load',
  },
  {
    code: 'EDGE_LOWERED_AS_RISING',
    severity: 'info',
    message: 'edge() lowered as rising()',
    stationId: 'st_weld',
  },
  {
    code: 'SOMETHING_BROKE',
    severity: 'error',
    message: 'simulated error',
  },
  {
    code: 'SOMETHING_BROKE',
    severity: 'error',
    message: 'simulated error',
  },
  {
    code: 'A_WARNING',
    severity: 'warning',
    message: 'mild',
  },
];

describe('aggregateDiagnostics', () => {
  it('counts severities correctly', () => {
    const c = aggregateDiagnostics(SAMPLE);
    expect(c).toEqual({ errors: 2, warnings: 1, info: 2 });
  });

  it('returns zero counts for an empty array', () => {
    expect(aggregateDiagnostics([])).toEqual({
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });
});

describe('dedupeDiagnostics', () => {
  it('removes byte-identical duplicates', () => {
    const out = dedupeDiagnostics(SAMPLE);
    expect(out).toHaveLength(SAMPLE.length - 1);
    expect(
      out.filter(
        (d) => d.code === 'SOMETHING_BROKE' && d.severity === 'error',
      ),
    ).toHaveLength(1);
  });

  it('keeps diagnostics that differ on path / station / symbol', () => {
    const dups: ArtifactDiagnostic[] = [
      { code: 'X', severity: 'info', message: 'same', stationId: 'a' },
      { code: 'X', severity: 'info', message: 'same', stationId: 'b' },
      { code: 'X', severity: 'info', message: 'same', stationId: 'b' }, // dup
    ];
    expect(dedupeDiagnostics(dups)).toHaveLength(2);
  });
});

describe('sortDiagnosticsForDisplay', () => {
  it('puts errors first, then warnings, then info', () => {
    const sorted = sortDiagnosticsForDisplay(SAMPLE);
    const severities = sorted.map((d) => d.severity);
    // No info should come before any error/warning.
    const firstInfoIdx = severities.indexOf('info');
    const lastErrorIdx = severities.lastIndexOf('error');
    const lastWarningIdx = severities.lastIndexOf('warning');
    expect(lastErrorIdx).toBeLessThan(firstInfoIdx);
    expect(lastWarningIdx).toBeLessThan(firstInfoIdx);
  });

  it('is stable for equal keys (re-sorting yields same order)', () => {
    const a = sortDiagnosticsForDisplay(SAMPLE);
    const b = sortDiagnosticsForDisplay([...a]);
    expect(a).toEqual(b);
  });

  it('does not mutate the input', () => {
    const original = [...SAMPLE];
    sortDiagnosticsForDisplay(SAMPLE);
    expect(SAMPLE).toEqual(original);
  });
});

// Sprint 72 — pure tests for diagnostic helpers.

import { describe, expect, it } from 'vitest';

import {
  countDiagnosticsBySeverity,
  createElectricalDiagnostic,
  dedupeElectricalDiagnostics,
  sortElectricalDiagnostics,
} from '../src/diagnostics.js';
import type { ElectricalDiagnostic } from '../src/types.js';

describe('createElectricalDiagnostic', () => {
  it('infers severity=error for endpoint / id / source-ref problems', () => {
    expect(
      createElectricalDiagnostic({ code: 'EDGE_ENDPOINT_MISSING', message: 'x' }).severity,
    ).toBe('error');
    expect(
      createElectricalDiagnostic({ code: 'DUPLICATE_NODE_ID', message: 'x' }).severity,
    ).toBe('error');
    expect(
      createElectricalDiagnostic({ code: 'SOURCE_REF_MISSING', message: 'x' }).severity,
    ).toBe('error');
  });

  it('infers severity=warning for ambiguity / low-confidence', () => {
    expect(
      createElectricalDiagnostic({ code: 'LOW_CONFIDENCE_DEVICE_CLASSIFICATION', message: 'x' })
        .severity,
    ).toBe('warning');
    expect(
      createElectricalDiagnostic({ code: 'AMBIGUOUS_DEVICE_KIND', message: 'x' }).severity,
    ).toBe('warning');
  });

  it('infers severity=info for unsupported source feature', () => {
    expect(
      createElectricalDiagnostic({ code: 'UNSUPPORTED_SOURCE_FEATURE', message: 'x' }).severity,
    ).toBe('info');
  });

  it('honours an explicit severity override', () => {
    expect(
      createElectricalDiagnostic({
        code: 'SOURCE_REF_MISSING',
        severity: 'info',
        message: 'x',
      }).severity,
    ).toBe('info');
  });

  it('only includes optional fields when provided', () => {
    const d = createElectricalDiagnostic({
      code: 'EDGE_ENDPOINT_MISSING',
      message: 'x',
      nodeId: 'n1',
    });
    expect(d.nodeId).toBe('n1');
    expect('edgeId' in d).toBe(false);
    expect('sourceRef' in d).toBe(false);
  });
});

describe('dedupeElectricalDiagnostics', () => {
  const a: ElectricalDiagnostic = {
    code: 'DUPLICATE_NODE_ID',
    severity: 'error',
    message: 'x',
    nodeId: 'n1',
  };
  const b: ElectricalDiagnostic = {
    code: 'DUPLICATE_NODE_ID',
    severity: 'error',
    message: 'x',
    nodeId: 'n1',
  };
  const c: ElectricalDiagnostic = {
    code: 'DUPLICATE_NODE_ID',
    severity: 'error',
    message: 'x',
    nodeId: 'n2',
  };

  it('keeps the first occurrence and drops structural duplicates', () => {
    expect(dedupeElectricalDiagnostics([a, b, c])).toEqual([a, c]);
  });

  it('does NOT key on sourceRef', () => {
    const d1 = { ...a, sourceRef: { sourceId: 's1', kind: 'manual' as const } };
    const d2 = { ...a, sourceRef: { sourceId: 's2', kind: 'manual' as const } };
    expect(dedupeElectricalDiagnostics([d1, d2])).toEqual([d1]);
  });
});

describe('sortElectricalDiagnostics', () => {
  it('sorts by severity (error, warning, info) then code', () => {
    const inp: ElectricalDiagnostic[] = [
      { code: 'IO_SIGNAL_MISSING_ADDRESS', severity: 'warning', message: 'b' },
      { code: 'DUPLICATE_NODE_ID', severity: 'error', message: 'a', nodeId: 'n1' },
      { code: 'UNSUPPORTED_SOURCE_FEATURE', severity: 'info', message: 'c' },
    ];
    const sorted = sortElectricalDiagnostics(inp);
    expect(sorted.map((d) => d.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('is stable on identical severity+code+message+nodeId+edgeId', () => {
    const same: ElectricalDiagnostic[] = [
      { code: 'AMBIGUOUS_DEVICE_KIND', severity: 'warning', message: 'x', nodeId: 'a' },
      { code: 'AMBIGUOUS_DEVICE_KIND', severity: 'warning', message: 'x', nodeId: 'a' },
    ];
    const sorted = sortElectricalDiagnostics(same);
    expect(sorted).toHaveLength(2);
  });

  it('does not mutate the caller array', () => {
    const inp: ElectricalDiagnostic[] = [
      { code: 'IO_SIGNAL_MISSING_ADDRESS', severity: 'warning', message: 'b' },
      { code: 'DUPLICATE_NODE_ID', severity: 'error', message: 'a' },
    ];
    const snap = JSON.stringify(inp);
    sortElectricalDiagnostics(inp);
    expect(JSON.stringify(inp)).toBe(snap);
  });
});

describe('countDiagnosticsBySeverity', () => {
  it('rolls up counts per severity', () => {
    expect(
      countDiagnosticsBySeverity([
        { code: 'EDGE_ENDPOINT_MISSING', severity: 'error', message: 'x' },
        { code: 'EDGE_ENDPOINT_MISSING', severity: 'error', message: 'y' },
        { code: 'AMBIGUOUS_DEVICE_KIND', severity: 'warning', message: 'z' },
      ]),
    ).toEqual({ error: 2, warning: 1, info: 0 });
  });
});

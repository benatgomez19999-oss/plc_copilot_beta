// Sprint 72 — pure tests for buildPirDraftCandidate. Architecture
// invariants this spec pins:
//   - Source refs propagate from the graph into IO + equipment
//     candidates.
//   - Low-confidence devices become assumptions/diagnostics, not
//     final equipment.
//   - Missing PLC addresses surface as IO_SIGNAL_MISSING_ADDRESS.
//   - Unknown direction surfaces as PLC_CHANNEL_UNRESOLVED.
//   - The mapper never invents IO or equipment.

import { describe, expect, it } from 'vitest';

import { confidenceOf } from '../src/confidence.js';
import {
  blockingDiagnostics,
  buildPirDraftCandidate,
} from '../src/mapping/pir-candidate.js';
import type {
  ElectricalEdge,
  ElectricalGraph,
  ElectricalNode,
  SourceRef,
} from '../src/types.js';

const ref: SourceRef = {
  sourceId: 'src-test',
  kind: 'manual',
  rawId: 'test',
};

function n(id: string, overrides: Partial<ElectricalNode> = {}): ElectricalNode {
  return {
    id,
    kind: overrides.kind ?? 'device',
    label: overrides.label ?? id,
    sourceRefs: overrides.sourceRefs ?? [ref],
    confidence: overrides.confidence ?? confidenceOf(0.9, 'test'),
    attributes: overrides.attributes ?? {},
    tags: overrides.tags,
  };
}

function e(id: string, from: string, to: string, kind: ElectricalEdge['kind'] = 'signals'): ElectricalEdge {
  return {
    id,
    kind,
    from,
    to,
    sourceRefs: [ref],
    confidence: confidenceOf(0.9, 'test'),
    attributes: {},
  };
}

function g(nodes: ElectricalNode[], edges: ElectricalEdge[] = []): ElectricalGraph {
  return {
    id: 'g1',
    sourceKind: 'manual',
    nodes,
    edges,
    diagnostics: [],
    metadata: {},
  };
}

describe('buildPirDraftCandidate', () => {
  it('produces an IO candidate from a plc_channel with address', () => {
    const graph = g([
      n('ch1', {
        kind: 'plc_channel',
        label: 'I0.0',
        attributes: { address: '%I0.0' },
      }),
    ]);
    const c = buildPirDraftCandidate(graph);
    expect(c.io).toHaveLength(1);
    expect(c.io[0].address).toBe('%I0.0');
    expect(c.io[0].direction).toBe('input');
    expect(c.io[0].sourceRefs.length).toBeGreaterThan(0);
  });

  it('emits IO_SIGNAL_MISSING_ADDRESS for plc_channel without address', () => {
    const graph = g([n('ch1', { kind: 'plc_channel', label: 'something' })]);
    const c = buildPirDraftCandidate(graph);
    const codes = c.diagnostics.map((d) => d.code);
    expect(codes).toContain('IO_SIGNAL_MISSING_ADDRESS');
  });

  it('emits PLC_CHANNEL_UNRESOLVED when direction cannot be inferred', () => {
    const graph = g([
      n('ch1', {
        kind: 'plc_channel',
        label: 'mystery',
        attributes: { address: 'mystery' }, // unrecognised → no direction
      }),
    ]);
    const c = buildPirDraftCandidate(graph);
    const codes = c.diagnostics.map((d) => d.code);
    expect(codes).toContain('PLC_CHANNEL_UNRESOLVED');
  });

  it('emits SOURCE_REF_MISSING when an IO candidate has no source refs', () => {
    const graph = g([
      n('ch1', {
        kind: 'plc_channel',
        sourceRefs: [],
        attributes: { address: '%Q1.0' },
      }),
    ]);
    const c = buildPirDraftCandidate(graph);
    const codes = c.diagnostics.map((d) => d.code);
    expect(codes).toContain('SOURCE_REF_MISSING');
  });

  it('promotes a sensor with high confidence to a final equipment candidate', () => {
    const graph = g(
      [
        n('s1', { kind: 'sensor', label: 'S1 limit-switch' }),
        n('ch1', { kind: 'plc_channel', attributes: { address: '%I0.0' } }),
      ],
      [e('e1', 'ch1', 's1', 'signals')],
    );
    const c = buildPirDraftCandidate(graph);
    expect(c.equipment).toHaveLength(1);
    expect(c.equipment[0].kind).toBe('sensor_discrete');
    expect(c.equipment[0].ioBindings).toMatchObject({ feedback: 'io_ch1' });
  });

  it('only assumes (not promotes) when device kind is unknown but label hints', () => {
    // Generic device with a label that *suggests* a motor pattern;
    // confidence should not clear the 0.6 threshold without
    // additional evidence.
    const graph = g([
      n('m1', {
        kind: 'unknown',
        label: 'M1 conveyor motor',
        confidence: confidenceOf(0.5, 'unknown kind, label hint'),
      }),
    ]);
    const c = buildPirDraftCandidate(graph);
    expect(c.equipment).toHaveLength(0);
    expect(c.assumptions.length).toBeGreaterThan(0);
    const codes = c.diagnostics.map((d) => d.code);
    expect(codes).toContain('LOW_CONFIDENCE_DEVICE_CLASSIFICATION');
  });

  it('emits UNKNOWN_DEVICE_ROLE when no role evidence exists', () => {
    const graph = g([
      n('thing', {
        kind: 'unknown',
        label: 'random_box',
        confidence: confidenceOf(0.1, 'no evidence'),
      }),
    ]);
    const c = buildPirDraftCandidate(graph);
    expect(c.equipment).toHaveLength(0);
    const codes = c.diagnostics.map((d) => d.code);
    expect(codes).toContain('UNKNOWN_DEVICE_ROLE');
  });

  it('skips infrastructure node kinds (terminals, cables, plc, modules)', () => {
    const graph = g(
      [
        n('plc1', { kind: 'plc' }),
        n('mod1', { kind: 'plc_module' }),
        n('cab1', { kind: 'cable' }),
        n('ts1', { kind: 'terminal_strip' }),
        n('w1', { kind: 'wire' }),
      ],
      [],
    );
    const c = buildPirDraftCandidate(graph);
    expect(c.equipment).toHaveLength(0);
    expect(c.io).toHaveLength(0);
  });

  it('preserves source refs in IO + equipment candidates', () => {
    const customRef: SourceRef = {
      sourceId: 'custom',
      kind: 'csv',
      path: 'tag-list.csv',
      line: 42,
    };
    const graph = g(
      [
        n('s1', {
          kind: 'sensor',
          label: 'S1',
          sourceRefs: [customRef],
        }),
        n('ch1', {
          kind: 'plc_channel',
          attributes: { address: '%I0.0' },
          sourceRefs: [customRef],
        }),
      ],
      [e('e1', 'ch1', 's1', 'signals')],
    );
    const c = buildPirDraftCandidate(graph);
    expect(c.io[0].sourceRefs).toContainEqual(customRef);
    expect(c.equipment[0].sourceRefs).toContainEqual(customRef);
  });

  it('does not invent IO or equipment for empty graphs', () => {
    const c = buildPirDraftCandidate(g([], []));
    expect(c.io).toHaveLength(0);
    expect(c.equipment).toHaveLength(0);
    expect(c.assumptions).toHaveLength(0);
  });

  it('blockingDiagnostics filters to severity=error only', () => {
    const graph = g([
      n('ch1', { kind: 'plc_channel', sourceRefs: [], attributes: { address: '%I0.0' } }),
    ]);
    const c = buildPirDraftCandidate(graph);
    const blocked = blockingDiagnostics(c);
    expect(blocked.every((d) => d.severity === 'error')).toBe(true);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('throws when the graph is missing', () => {
    expect(() => buildPirDraftCandidate(null as any)).toThrow();
  });

  it('honours minEquipmentConfidence override', () => {
    const graph = g([n('s1', { kind: 'sensor', label: 'S1' })]);
    // High threshold — even a 0.9-kind sensor falls to assumption.
    const c = buildPirDraftCandidate(graph, { minEquipmentConfidence: 0.99 });
    expect(c.equipment).toHaveLength(0);
    expect(c.assumptions.length).toBeGreaterThan(0);
  });
});

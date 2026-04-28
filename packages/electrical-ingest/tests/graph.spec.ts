// Sprint 72 — pure tests for the electrical graph helpers. No I/O,
// no fixtures on disk; every test builds a small in-memory graph.

import { describe, expect, it } from 'vitest';

import { confidenceOf } from '../src/confidence.js';
import {
  connectedComponents,
  findEdgesFrom,
  findEdgesTo,
  findNode,
  indexElectricalGraph,
  tracePath,
  validateElectricalGraph,
} from '../src/graph.js';
import type {
  ElectricalEdge,
  ElectricalGraph,
  ElectricalNode,
  SourceRef,
} from '../src/types.js';

const sourceRef: SourceRef = {
  sourceId: 'src-test',
  kind: 'manual',
  rawId: 'test',
};

function node(id: string, kind: ElectricalNode['kind'] = 'device'): ElectricalNode {
  return {
    id,
    kind,
    label: id,
    sourceRefs: [sourceRef],
    confidence: confidenceOf(0.8, 'test'),
    attributes: {},
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ElectricalEdge['kind'] = 'connected_to',
): ElectricalEdge {
  return {
    id,
    kind,
    from,
    to,
    sourceRefs: [sourceRef],
    confidence: confidenceOf(0.8, 'test'),
    attributes: {},
  };
}

function graph(nodes: ElectricalNode[], edges: ElectricalEdge[]): ElectricalGraph {
  return {
    id: 'g1',
    sourceKind: 'manual',
    nodes,
    edges,
    diagnostics: [],
    metadata: {},
  };
}

// =============================================================================
// indexElectricalGraph
// =============================================================================

describe('indexElectricalGraph', () => {
  it('builds nodesById / edgesById / outgoing / incoming maps', () => {
    const g = graph(
      [node('a'), node('b'), node('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'a', 'c')],
    );
    const idx = indexElectricalGraph(g);
    expect(idx.nodesById.get('a')?.id).toBe('a');
    expect(idx.nodesById.size).toBe(3);
    expect(idx.edgesById.size).toBe(3);
    expect((idx.outgoingByNodeId.get('a') ?? []).map((e) => e.id).sort()).toEqual(['e1', 'e3']);
    expect((idx.incomingByNodeId.get('c') ?? []).map((e) => e.id).sort()).toEqual(['e2', 'e3']);
  });
});

// =============================================================================
// findNode / findEdgesFrom / findEdgesTo
// =============================================================================

describe('findNode / findEdgesFrom / findEdgesTo', () => {
  const g = graph(
    [node('a'), node('b'), node('c')],
    [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
  );

  it('findNode returns the node or undefined', () => {
    expect(findNode(g, 'b')?.id).toBe('b');
    expect(findNode(g, 'zz')).toBeUndefined();
  });

  it('findEdgesFrom is deterministic', () => {
    expect(findEdgesFrom(g, 'a').map((e) => e.id)).toEqual(['e1']);
    expect(findEdgesFrom(g, 'b').map((e) => e.id)).toEqual(['e2']);
    expect(findEdgesFrom(g, 'c')).toEqual([]);
  });

  it('findEdgesTo is deterministic', () => {
    expect(findEdgesTo(g, 'a')).toEqual([]);
    expect(findEdgesTo(g, 'b').map((e) => e.id)).toEqual(['e1']);
    expect(findEdgesTo(g, 'c').map((e) => e.id)).toEqual(['e2']);
  });
});

// =============================================================================
// validateElectricalGraph
// =============================================================================

describe('validateElectricalGraph', () => {
  it('returns no diagnostics for a clean graph', () => {
    const g = graph([node('a'), node('b')], [edge('e1', 'a', 'b')]);
    expect(validateElectricalGraph(g)).toEqual([]);
  });

  it('flags duplicate node ids', () => {
    const g = graph([node('a'), node('a')], []);
    const codes = validateElectricalGraph(g).map((d) => d.code);
    expect(codes).toContain('DUPLICATE_NODE_ID');
  });

  it('flags edge endpoint missing (from)', () => {
    const g = graph([node('a')], [edge('e1', 'missing', 'a')]);
    const codes = validateElectricalGraph(g).map((d) => d.code);
    expect(codes).toContain('EDGE_ENDPOINT_MISSING');
  });

  it('flags edge endpoint missing (to)', () => {
    const g = graph([node('a')], [edge('e1', 'a', 'missing')]);
    const codes = validateElectricalGraph(g).map((d) => d.code);
    expect(codes).toContain('EDGE_ENDPOINT_MISSING');
  });

  it('flags missing source refs on nodes when required (default)', () => {
    const noRefNode: ElectricalNode = {
      ...node('x'),
      sourceRefs: [],
    };
    const g = graph([noRefNode], []);
    const codes = validateElectricalGraph(g).map((d) => d.code);
    expect(codes).toContain('SOURCE_REF_MISSING');
  });

  it('does NOT flag missing source refs when requireSourceRefs=false', () => {
    const noRefNode: ElectricalNode = {
      ...node('x'),
      sourceRefs: [],
    };
    const g = graph([noRefNode], []);
    const codes = validateElectricalGraph(g, { requireSourceRefs: false }).map(
      (d) => d.code,
    );
    expect(codes).not.toContain('SOURCE_REF_MISSING');
  });
});

// =============================================================================
// tracePath
// =============================================================================

describe('tracePath', () => {
  it('returns [] when from === to', () => {
    const g = graph([node('a')], []);
    expect(tracePath(g, 'a', 'a')).toEqual([]);
  });

  it('returns the path edge for a single hop', () => {
    const g = graph([node('a'), node('b')], [edge('e1', 'a', 'b')]);
    const path = tracePath(g, 'a', 'b');
    expect(path?.map((e) => e.id)).toEqual(['e1']);
  });

  it('finds the shortest path through a multi-hop graph', () => {
    const g = graph(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd'), edge('e4', 'a', 'd')],
    );
    const path = tracePath(g, 'a', 'd');
    expect(path?.map((e) => e.id)).toEqual(['e4']);
  });

  it('returns null when no path exists', () => {
    const g = graph([node('a'), node('b')], []);
    expect(tracePath(g, 'a', 'b')).toBeNull();
  });

  it('honours edgeKinds filter', () => {
    const g = graph(
      [node('a'), node('b')],
      [edge('e1', 'a', 'b', 'connected_to'), edge('e2', 'a', 'b', 'wired_to')],
    );
    const path = tracePath(g, 'a', 'b', { edgeKinds: ['wired_to'] });
    expect(path?.map((e) => e.id)).toEqual(['e2']);
  });

  it('bidirectional follows incoming edges too', () => {
    const g = graph(
      [node('a'), node('b'), node('c')],
      [edge('e1', 'b', 'a'), edge('e2', 'b', 'c')],
    );
    expect(tracePath(g, 'a', 'c')).toBeNull();
    const path = tracePath(g, 'a', 'c', { bidirectional: true });
    expect(path?.length).toBe(2);
  });
});

// =============================================================================
// connectedComponents
// =============================================================================

describe('connectedComponents', () => {
  it('groups disjoint subgraphs', () => {
    const g = graph(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('e1', 'a', 'b'), edge('e2', 'c', 'd')],
    );
    const comps = connectedComponents(g);
    expect(comps).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('singleton nodes are their own component', () => {
    const g = graph([node('a'), node('b')], []);
    expect(connectedComponents(g)).toEqual([['a'], ['b']]);
  });

  it('treats edges as undirected', () => {
    const g = graph(
      [node('a'), node('b'), node('c')],
      [edge('e1', 'a', 'b'), edge('e2', 'c', 'b')],
    );
    expect(connectedComponents(g)).toEqual([['a', 'b', 'c']]);
  });
});

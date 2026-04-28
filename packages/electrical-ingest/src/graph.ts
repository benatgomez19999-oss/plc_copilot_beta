// Sprint 72 — pure helpers over `ElectricalGraph`. No I/O, no
// randomness, no Date.now. Algorithms are deterministic: when the
// graph defines a stable iteration order (its `nodes` / `edges`
// arrays), all helpers preserve it.

import { createElectricalDiagnostic } from './diagnostics.js';
import type {
  ElectricalDiagnostic,
  ElectricalEdge,
  ElectricalGraph,
  ElectricalNode,
} from './types.js';

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface ElectricalGraphIndex {
  nodesById: ReadonlyMap<string, ElectricalNode>;
  edgesById: ReadonlyMap<string, ElectricalEdge>;
  outgoingByNodeId: ReadonlyMap<string, readonly ElectricalEdge[]>;
  incomingByNodeId: ReadonlyMap<string, readonly ElectricalEdge[]>;
}

/**
 * Build a deterministic index over the graph. Repeat calls on the
 * same graph instance return equivalent indices. The lookups are
 * `readonly` to discourage accidental mutation.
 */
export function indexElectricalGraph(graph: ElectricalGraph): ElectricalGraphIndex {
  const nodesById = new Map<string, ElectricalNode>();
  for (const n of graph.nodes) nodesById.set(n.id, n);

  const edgesById = new Map<string, ElectricalEdge>();
  const outgoing = new Map<string, ElectricalEdge[]>();
  const incoming = new Map<string, ElectricalEdge[]>();
  for (const e of graph.edges) {
    edgesById.set(e.id, e);
    const out = outgoing.get(e.from) ?? [];
    out.push(e);
    outgoing.set(e.from, out);
    const inc = incoming.get(e.to) ?? [];
    inc.push(e);
    incoming.set(e.to, inc);
  }

  return {
    nodesById,
    edgesById,
    outgoingByNodeId: outgoing,
    incomingByNodeId: incoming,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findNode(
  graph: ElectricalGraph,
  id: string,
): ElectricalNode | undefined {
  for (const n of graph.nodes) if (n.id === id) return n;
  return undefined;
}

export function findEdgesFrom(
  graph: ElectricalGraph,
  id: string,
): ElectricalEdge[] {
  return graph.edges.filter((e) => e.from === id);
}

export function findEdgesTo(
  graph: ElectricalGraph,
  id: string,
): ElectricalEdge[] {
  return graph.edges.filter((e) => e.to === id);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationOptions {
  /**
   * If true, emit a SOURCE_REF_MISSING diagnostic for every node
   * with an empty `sourceRefs` array. Default true — Sprint 72's
   * architecture invariant says every fact must be traceable.
   */
  requireSourceRefs?: boolean;
}

/**
 * Cross-check a graph against the architectural invariants:
 *   - node ids unique
 *   - every edge's `from` + `to` resolves to a node
 *   - every node has at least one source ref (when required)
 *
 * Returns diagnostics (does NOT mutate the graph). The caller can
 * append them to `graph.diagnostics` if desired.
 */
export function validateElectricalGraph(
  graph: ElectricalGraph,
  options: ValidationOptions = {},
): ElectricalDiagnostic[] {
  const requireSourceRefs = options.requireSourceRefs !== false;
  const diagnostics: ElectricalDiagnostic[] = [];

  // Duplicate node ids.
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'DUPLICATE_NODE_ID',
          message: `node id ${JSON.stringify(n.id)} is used more than once.`,
          nodeId: n.id,
        }),
      );
    } else {
      seen.add(n.id);
    }
    if (
      requireSourceRefs &&
      (!Array.isArray(n.sourceRefs) || n.sourceRefs.length === 0)
    ) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'SOURCE_REF_MISSING',
          message: `node ${JSON.stringify(n.id)} has no sourceRefs.`,
          nodeId: n.id,
          hint: 'every node must trace back to at least one source (file/page/symbol).',
        }),
      );
    }
  }

  // Edge endpoints must resolve.
  for (const e of graph.edges) {
    if (!seen.has(e.from)) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EDGE_ENDPOINT_MISSING',
          message: `edge ${JSON.stringify(e.id)} references missing source node ${JSON.stringify(e.from)}.`,
          edgeId: e.id,
        }),
      );
    }
    if (!seen.has(e.to)) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'EDGE_ENDPOINT_MISSING',
          message: `edge ${JSON.stringify(e.id)} references missing target node ${JSON.stringify(e.to)}.`,
          edgeId: e.id,
        }),
      );
    }
    if (
      requireSourceRefs &&
      (!Array.isArray(e.sourceRefs) || e.sourceRefs.length === 0)
    ) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'SOURCE_REF_MISSING',
          message: `edge ${JSON.stringify(e.id)} has no sourceRefs.`,
          edgeId: e.id,
          hint: 'every edge must trace back to at least one source (file/page/symbol).',
        }),
      );
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Path search
// ---------------------------------------------------------------------------

export interface TracePathOptions {
  /**
   * Maximum number of edges to follow before giving up. Defaults to
   * `graph.edges.length` so worst-case exploration is bounded by
   * the graph size.
   */
  maxDepth?: number;
  /**
   * Only follow edges whose `kind` is in this set. If omitted, all
   * edges are eligible. Useful for "wired_to + connected_to only"
   * traces.
   */
  edgeKinds?: ReadonlyArray<ElectricalEdge['kind']>;
  /**
   * If true, follow edges in *both* directions; default false (only
   * outgoing edges from `from`).
   */
  bidirectional?: boolean;
}

/**
 * BFS for the shortest path from `fromId` to `toId`. Returns the
 * sequence of edges to follow (in order) or null if no path exists
 * within `maxDepth`. Deterministic — uses graph.edges insertion
 * order.
 */
export function tracePath(
  graph: ElectricalGraph,
  fromId: string,
  toId: string,
  options: TracePathOptions = {},
): ElectricalEdge[] | null {
  if (fromId === toId) return [];
  const idx = indexElectricalGraph(graph);
  if (!idx.nodesById.has(fromId) || !idx.nodesById.has(toId)) return null;
  const maxDepth = options.maxDepth ?? graph.edges.length;
  const allowed = options.edgeKinds ? new Set(options.edgeKinds) : null;
  const visited = new Set<string>([fromId]);
  // BFS frontier: stores the predecessor edge to reconstruct the path.
  const cameFrom = new Map<string, ElectricalEdge>();
  let frontier: string[] = [fromId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const here of frontier) {
      const outs = idx.outgoingByNodeId.get(here) ?? [];
      const ins = options.bidirectional
        ? idx.incomingByNodeId.get(here) ?? []
        : [];
      const candidates = [...outs, ...ins];
      for (const edge of candidates) {
        if (allowed && !allowed.has(edge.kind)) continue;
        const neighbour = edge.from === here ? edge.to : edge.from;
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        cameFrom.set(neighbour, edge);
        if (neighbour === toId) {
          // Reconstruct.
          const path: ElectricalEdge[] = [];
          let cursor = neighbour;
          while (cursor !== fromId) {
            const e = cameFrom.get(cursor);
            if (!e) return null;
            path.unshift(e);
            cursor = e.from === cursor ? e.to : e.from;
          }
          return path;
        }
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

/**
 * Compute connected components, treating edges as undirected.
 * Returns arrays of node ids; each array is sorted, and the outer
 * list is sorted by the first id (so the output is deterministic).
 */
export function connectedComponents(graph: ElectricalGraph): string[][] {
  const idx = indexElectricalGraph(graph);
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const n of graph.nodes) {
    if (visited.has(n.id)) continue;
    const stack = [n.id];
    const component: string[] = [];
    while (stack.length > 0) {
      const here = stack.pop()!;
      if (visited.has(here)) continue;
      visited.add(here);
      component.push(here);
      const neighbours = [
        ...(idx.outgoingByNodeId.get(here) ?? []).map((e) => e.to),
        ...(idx.incomingByNodeId.get(here) ?? []).map((e) => e.from),
      ];
      for (const neigh of neighbours) {
        if (!visited.has(neigh)) stack.push(neigh);
      }
    }
    component.sort((a, b) => a.localeCompare(b));
    components.push(component);
  }
  components.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return components;
}

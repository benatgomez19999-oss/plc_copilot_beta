import type {
  Equipment,
  Machine,
  Project,
  Station,
} from '@plccopilot/pir';

// =============================================================================
// Node shapes — flat (`PirStructureNode`) and recursive (`PirStructureNodeTree`).
// JSONPaths use the `$.machines[0].stations[1].equipment[2]` form that
// `parseJsonPath` / `findJsonPathLine` (json-locator.ts) understand.
// =============================================================================

export type PirStructureNodeKind =
  | 'project'
  | 'machine'
  | 'station'
  | 'equipment';

/**
 * Tuple of array indices pointing at this node within `Project`. The
 * resolver layer consumes these to look up the underlying record without
 * re-walking the tree:
 *
 *   - project   → `{}` (no indices needed)
 *   - machine   → `{ machineIndex }`
 *   - station   → `{ machineIndex, stationIndex }`
 *   - equipment → `{ machineIndex, stationIndex, equipmentIndex }`
 *
 * Optional fields keep the type structurally compatible with the project-
 * level node, where every index is undefined.
 */
export interface PirStructureNodeRefs {
  machineIndex?: number;
  stationIndex?: number;
  equipmentIndex?: number;
}

export interface PirStructureNode {
  kind: PirStructureNodeKind;
  id: string;
  label: string;
  jsonPath: string;
  summary: Record<string, string | number>;
  refs?: PirStructureNodeRefs;
}

export interface PirStructureNodeTree extends PirStructureNode {
  children: PirStructureNodeTree[];
}

// =============================================================================
// Builders
// =============================================================================

export function buildPirStructure(project: Project): PirStructureNodeTree {
  return {
    kind: 'project',
    id: project.id,
    label: project.name || project.id,
    jsonPath: '$',
    summary: projectSummary(project),
    refs: {},
    children: project.machines.map((m, mi) => buildMachineNode(m, mi)),
  };
}

function buildMachineNode(
  machine: Machine,
  machineIdx: number,
): PirStructureNodeTree {
  const machinePath = `$.machines[${machineIdx}]`;
  return {
    kind: 'machine',
    id: machine.id,
    label: machine.name || machine.id,
    jsonPath: machinePath,
    summary: machineSummary(machine),
    refs: { machineIndex: machineIdx },
    children: machine.stations.map((s, si) =>
      buildStationNode(s, machinePath, machineIdx, si),
    ),
  };
}

function buildStationNode(
  station: Station,
  machinePath: string,
  machineIdx: number,
  stationIdx: number,
): PirStructureNodeTree {
  const stationPath = `${machinePath}.stations[${stationIdx}]`;
  return {
    kind: 'station',
    id: station.id,
    label: station.name || station.id,
    jsonPath: stationPath,
    summary: stationSummary(station),
    refs: { machineIndex: machineIdx, stationIndex: stationIdx },
    children: station.equipment.map((eq, ei) =>
      buildEquipmentNode(eq, stationPath, machineIdx, stationIdx, ei),
    ),
  };
}

function buildEquipmentNode(
  eq: Equipment,
  stationPath: string,
  machineIdx: number,
  stationIdx: number,
  eqIdx: number,
): PirStructureNodeTree {
  const eqRecord = eq as unknown as Record<string, unknown>;
  const codeSymbol =
    typeof eqRecord.code_symbol === 'string' ? eqRecord.code_symbol : null;
  return {
    kind: 'equipment',
    id: eq.id,
    label: codeSymbol ?? eq.id,
    jsonPath: `${stationPath}.equipment[${eqIdx}]`,
    summary: equipmentSummary(eq),
    refs: {
      machineIndex: machineIdx,
      stationIndex: stationIdx,
      equipmentIndex: eqIdx,
    },
    children: [],
  };
}

// =============================================================================
// Flatten — depth-first order for tooling that wants the linear list
// (`select-all`, JSON export, etc.).
// =============================================================================

export function flattenPirStructure(
  tree: PirStructureNodeTree,
): PirStructureNode[] {
  const out: PirStructureNode[] = [];
  function visit(node: PirStructureNodeTree): void {
    out.push(stripChildren(node));
    for (const c of node.children) visit(c);
  }
  visit(tree);
  return out;
}

/**
 * Find a node by exact `jsonPath`. Accepts either a flat list (the
 * output of `flattenPirStructure`, where each level appears once) or
 * a tree-rooted array (caller passes `[root]` and we recurse into
 * `children`).
 *
 * Used by App so the open-validation-issues panel can derive a fresh
 * `label` from the live structure tree on every render — if the user
 * renames a node while the panel is open, the header updates.
 *
 * Substring trap is impossible because we strict-equality check the
 * full path (`'$.machines[1]'` never matches `'$.machines[10]'`).
 * Empty / non-string `jsonPath` → `null`. The recursion is tolerant
 * via duck-typing: `PirStructureNode[]` callers (no `children` field)
 * skip the recursive branch automatically.
 */
export function findPirStructureNodeByPath(
  nodes: readonly PirStructureNode[],
  jsonPath: string,
): PirStructureNode | null {
  if (typeof jsonPath !== 'string' || jsonPath === '') return null;
  for (const n of nodes) {
    if (n.jsonPath === jsonPath) return n;
    // Duck-type: when the caller hands us `PirStructureNodeTree[]` the
    // children array is iterable; for plain `PirStructureNode[]`
    // (flat lists) the property is missing and we skip the recursion.
    const children = (n as PirStructureNodeTree).children;
    if (Array.isArray(children) && children.length > 0) {
      const found = findPirStructureNodeByPath(children, jsonPath);
      if (found) return found;
    }
  }
  return null;
}

function stripChildren(node: PirStructureNodeTree): PirStructureNode {
  // Build a fresh object so callers can't mutate the tree via the flat list.
  // `refs` is shallow-copied — its members are primitive indices, no aliasing
  // concerns, but a fresh object lets callers attach metadata if they want.
  return {
    kind: node.kind,
    id: node.id,
    label: node.label,
    jsonPath: node.jsonPath,
    summary: { ...node.summary },
    refs: node.refs ? { ...node.refs } : undefined,
  };
}

// =============================================================================
// Per-kind summaries — defensive against optional / vendor-extension fields.
// =============================================================================

function projectSummary(p: Project): Record<string, string | number> {
  return {
    id: p.id,
    name: p.name,
    pir_version: p.pir_version,
    machines: p.machines.length,
  };
}

function machineSummary(m: Machine): Record<string, string | number> {
  const summary: Record<string, string | number> = {
    id: m.id,
    name: m.name,
    stations: m.stations.length,
    io: m.io.length,
    alarms: m.alarms.length,
    interlocks: m.interlocks.length,
    parameters: m.parameters.length,
    recipes: m.recipes.length,
    safety_groups: m.safety_groups.length,
  };
  // `modes` is a vendor-extension field — present on some hand-rolled PIRs
  // but not in the canonical schema. Surface its count when it shows up.
  const mRec = m as unknown as Record<string, unknown>;
  if (Array.isArray(mRec.modes)) {
    summary.modes = (mRec.modes as unknown[]).length;
  }
  return summary;
}

function stationSummary(s: Station): Record<string, string | number> {
  // `sequence` is required by the PIR schema, but we read it through the
  // structural cast so this util tolerates hand-crafted partial fixtures
  // (used by unit tests).
  const seq = (
    s as unknown as {
      sequence?: { states?: unknown[]; transitions?: unknown[] };
    }
  ).sequence;
  return {
    id: s.id,
    name: s.name,
    equipment: s.equipment.length,
    states: Array.isArray(seq?.states) ? seq.states.length : 0,
    transitions: Array.isArray(seq?.transitions)
      ? seq.transitions.length
      : 0,
  };
}

function equipmentSummary(eq: Equipment): Record<string, string | number> {
  const summary: Record<string, string | number> = {
    id: eq.id,
    type: eq.type,
  };
  const rec = eq as unknown as Record<string, unknown>;
  if (typeof rec.code_symbol === 'string') {
    summary.code_symbol = rec.code_symbol;
  }
  // `io_bindings` on Equipment is `Record<string, Id>` per the PIR schema —
  // count keys, not array length. Defensive against missing field on hand-
  // crafted partial fixtures.
  if (
    rec.io_bindings &&
    typeof rec.io_bindings === 'object' &&
    !Array.isArray(rec.io_bindings)
  ) {
    summary.io_bindings = Object.keys(
      rec.io_bindings as Record<string, unknown>,
    ).length;
  }
  // `timing` is also a record on Equipment; surface its key count when it
  // exists so the operator sees the timeout / debounce dimensions at a
  // glance from the navigator.
  if (
    rec.timing &&
    typeof rec.timing === 'object' &&
    !Array.isArray(rec.timing)
  ) {
    summary.timing = Object.keys(
      rec.timing as Record<string, unknown>,
    ).length;
  }
  return summary;
}

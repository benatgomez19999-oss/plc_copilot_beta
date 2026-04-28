// Sprint 72 — `buildPirDraftCandidate`. Pure mapper from
// `ElectricalGraph` to `PirDraftCandidate`. Honest scope:
//
//   - Generates *draft* IO + equipment candidates only when the
//     graph contains traceable evidence.
//   - Emits assumptions for inferred device roles (so a future
//     review UI can surface "this is why we classified X as Y").
//   - Emits diagnostics for unresolvable / low-confidence cases —
//     does NOT silently drop the node and does NOT silently
//     promote a guess to a "fact".
//   - Does NOT emit any final PIR shape. Sprint 72 stops at the
//     candidate model; the PIR builder is future work.

import { confidenceOf, minConfidence } from '../confidence.js';
import { createElectricalDiagnostic } from '../diagnostics.js';
import { mergeSourceRefs } from '../sources/trace.js';
import {
  inferEquipmentRole,
  inferIoRole,
} from './io-role-inference.js';
import type {
  ElectricalDiagnostic,
  ElectricalGraph,
  ElectricalNode,
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  PirMappingAssumption,
} from '../types.js';

const MIN_EQUIPMENT_CONFIDENCE = 0.6;
const ASSUMPTION_CONFIDENCE_FLOOR = 0.3;

export interface BuildPirDraftCandidateOptions {
  /**
   * Minimum confidence for an equipment candidate to be promoted
   * out of "assumption" status. Default 0.6.
   */
  minEquipmentConfidence?: number;
  /**
   * Identifier for the resulting PirDraftCandidate. Defaults to
   * `${graph.id}:draft`.
   */
  candidateId?: string;
}

export function buildPirDraftCandidate(
  graph: ElectricalGraph,
  options: BuildPirDraftCandidateOptions = {},
): PirDraftCandidate {
  if (!graph || typeof graph !== 'object') {
    throw new Error('buildPirDraftCandidate: graph must be an object.');
  }
  const minEquip =
    typeof options.minEquipmentConfidence === 'number' &&
    Number.isFinite(options.minEquipmentConfidence)
      ? Math.max(0, Math.min(1, options.minEquipmentConfidence))
      : MIN_EQUIPMENT_CONFIDENCE;

  const candidate: PirDraftCandidate = {
    id: options.candidateId ?? `${graph.id ?? 'graph'}:draft`,
    name: graph.name,
    io: [],
    equipment: [],
    diagnostics: [],
    assumptions: [],
    sourceGraphId: graph.id,
  };

  // -------------------------------------------------------------
  // Pass 1 — IO candidates from plc_channel + signal-bearing nodes.
  // -------------------------------------------------------------
  const ioByNodeId = new Map<string, PirIoCandidate>();
  for (const n of graph.nodes) {
    if (n.kind !== 'plc_channel') continue;
    const inferred = inferIoRole(n);
    const io: PirIoCandidate = {
      id: `io_${n.id}`,
      address: inferred.address,
      signalType: inferred.signalType,
      direction: inferred.direction,
      label: n.label,
      sourceRefs: mergeSourceRefs(n.sourceRefs),
      confidence: inferred.confidence,
    };
    candidate.io.push(io);
    ioByNodeId.set(n.id, io);

    if ((io.sourceRefs?.length ?? 0) === 0) {
      candidate.diagnostics.push(
        createElectricalDiagnostic({
          code: 'SOURCE_REF_MISSING',
          message: `IO candidate ${io.id} has no source refs.`,
          nodeId: n.id,
        }),
      );
    }
    if (!io.address) {
      candidate.diagnostics.push(
        createElectricalDiagnostic({
          code: 'IO_SIGNAL_MISSING_ADDRESS',
          message: `IO candidate ${io.id} (label ${JSON.stringify(io.label ?? '')}) has no resolvable PLC address.`,
          nodeId: n.id,
          hint:
            'set the node.attributes.address to a strict-form channel like %I0.0 / %Q1.7 / Local:1:I.Data[0].0.',
        }),
      );
    }
    if (io.direction === 'unknown') {
      candidate.diagnostics.push(
        createElectricalDiagnostic({
          code: 'PLC_CHANNEL_UNRESOLVED',
          message: `IO candidate ${io.id} has direction='unknown'.`,
          nodeId: n.id,
        }),
      );
    }
  }

  // -------------------------------------------------------------
  // Pass 2 — equipment candidates. Each plc_channel is matched to
  // its connected device (via `signals` / `drives` / `wired_to`
  // edges); only devices whose role is inferred above the threshold
  // become PirEquipmentCandidates. Lower confidence becomes an
  // *assumption* rather than a final equipment record.
  // -------------------------------------------------------------
  const seenDeviceIds = new Set<string>();
  for (const n of graph.nodes) {
    if (
      n.kind === 'plc_channel' ||
      n.kind === 'plc' ||
      n.kind === 'plc_module' ||
      n.kind === 'wire' ||
      n.kind === 'cable' ||
      n.kind === 'terminal' ||
      n.kind === 'terminal_strip' ||
      n.kind === 'connector' ||
      n.kind === 'power_supply'
    ) {
      continue;
    }
    if (seenDeviceIds.has(n.id)) continue;
    seenDeviceIds.add(n.id);

    const role = inferEquipmentRole(n);
    const ioBindings = collectIoBindings(graph, n, ioByNodeId);
    const refs = mergeSourceRefs(
      n.sourceRefs,
      ...Object.values(ioBindings).map((ioId) => {
        const io = candidate.io.find((c) => c.id === ioId);
        return io?.sourceRefs ?? [];
      }),
    );
    const combined = minConfidence([role.confidence, n.confidence ?? confidenceOf(0, 'no node confidence')]);

    if (role.kind !== 'unknown' && combined.score >= minEquip) {
      const equipment: PirEquipmentCandidate = {
        id: `eq_${n.id}`,
        kind: role.kind,
        ioBindings,
        sourceRefs: refs,
        confidence: combined,
      };
      candidate.equipment.push(equipment);
    } else if (
      role.kind !== 'unknown' ||
      combined.score >= ASSUMPTION_CONFIDENCE_FLOOR
    ) {
      const assumption: PirMappingAssumption = {
        id: `assum_${n.id}`,
        message: `device ${JSON.stringify(n.id)} (label ${JSON.stringify(n.label ?? '')}) was tentatively classified as ${role.kind} (confidence ${combined.score.toFixed(2)}).`,
        confidence: combined,
        sourceRefs: refs,
      };
      candidate.assumptions.push(assumption);
      candidate.diagnostics.push(
        createElectricalDiagnostic({
          code: 'LOW_CONFIDENCE_DEVICE_CLASSIFICATION',
          message: assumption.message,
          nodeId: n.id,
          hint: `provide a stronger label / IEC 61346 tag, or set node.kind explicitly.`,
        }),
      );
    } else {
      candidate.diagnostics.push(
        createElectricalDiagnostic({
          code: 'UNKNOWN_DEVICE_ROLE',
          message: `device ${JSON.stringify(n.id)} (label ${JSON.stringify(n.label ?? '')}) could not be classified — no PIR equipment candidate generated.`,
          nodeId: n.id,
          hint: 'add a recognisable label, IEC tag, or set node.kind to one of: sensor / motor / valve.',
        }),
      );
    }
  }

  return candidate;
}

/**
 * For a given device node, find which plc_channel nodes are wired
 * or connected to it (via `signals` / `drives` / `wired_to` edges)
 * and pair them with the IO candidate ids previously created in
 * pass 1. Bindings are direction-aware: outputs go on the "drive"
 * key, inputs on the "feedback" key — kept simple for Sprint 72.
 */
function collectIoBindings(
  graph: ElectricalGraph,
  device: ElectricalNode,
  ioByNodeId: Map<string, PirIoCandidate>,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  let outputCount = 0;
  let inputCount = 0;

  for (const e of graph.edges) {
    if (
      e.kind !== 'signals' &&
      e.kind !== 'drives' &&
      e.kind !== 'wired_to' &&
      e.kind !== 'maps_to_channel'
    ) {
      continue;
    }
    let channelId: string | null = null;
    if (e.from === device.id && ioByNodeId.has(e.to)) channelId = e.to;
    else if (e.to === device.id && ioByNodeId.has(e.from)) channelId = e.from;
    if (!channelId) continue;
    const io = ioByNodeId.get(channelId)!;
    if (io.direction === 'output') {
      bindings[outputCount === 0 ? 'drive' : `drive_${outputCount}`] = io.id;
      outputCount++;
    } else if (io.direction === 'input') {
      bindings[inputCount === 0 ? 'feedback' : `feedback_${inputCount}`] = io.id;
      inputCount++;
    } else {
      bindings[`io_${Object.keys(bindings).length}`] = io.id;
    }
  }
  return bindings;
}

/**
 * Convenience: filter PIR draft diagnostics to only the ones that
 * indicate a *blocking* problem (errors). Useful for "is this
 * candidate ready to promote?" gates.
 */
export function blockingDiagnostics(
  candidate: PirDraftCandidate,
): ElectricalDiagnostic[] {
  return candidate.diagnostics.filter((d) => d.severity === 'error');
}

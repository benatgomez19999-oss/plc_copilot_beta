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
  ElectricalParameterDraft,
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  PirMappingAssumption,
  PirParameterCandidate,
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

  // -------------------------------------------------------------
  // Sprint 88L — Pass 3: parameter-draft sidecar from
  // graph.metadata.parameterDraft (populated by ingestors that
  // recognise explicit Parameter / setpoint_binding metadata —
  // CSV today; EPLAN / TcECAD safe-no-op when metadata absent).
  // Pure / read-only — never inferred from labels or comments.
  // -------------------------------------------------------------
  applyParameterDraft(candidate, graph.metadata?.parameterDraft);

  return candidate;
}

/**
 * Sprint 88L — copy the parameter draft sidecar from the graph
 * metadata onto the candidate:
 *
 *   - `draft.parameters` → `candidate.parameters`
 *   - `draft.setpointBindings[<equipment_id>]` → matching equipment
 *     candidate's `ioSetpointBindings`
 *   - `draft.diagnostics` → `candidate.diagnostics` (deduplicated
 *     against the diagnostics already attached to the graph)
 *
 * If the draft references an equipment id that no equipment
 * candidate matches (raw tag mismatch, or the device-row produced
 * an `assumption` rather than a candidate), the binding is dropped
 * with a `CSV_SETPOINT_BINDING_TARGET_MISSING` diagnostic.
 */
function applyParameterDraft(
  candidate: PirDraftCandidate,
  draft: ElectricalParameterDraft | undefined,
): void {
  if (!draft) return;
  if (draft.parameters.length > 0) {
    candidate.parameters = draft.parameters.map((p) => ({
      ...p,
      sourceRefs: [...p.sourceRefs],
    }));
  }

  // Push diagnostics from the draft (parameter / binding rows) onto
  // the candidate so review surfaces them. The graph's diagnostic
  // list already carries the same set; we dedupe by code+message+
  // sourceRef.line to keep the candidate's view clean.
  const seen = new Set<string>(
    candidate.diagnostics.map(
      (d) =>
        `${d.code}|${d.message}|${d.sourceRef?.sourceId ?? ''}|${d.sourceRef?.line ?? ''}`,
    ),
  );
  for (const d of draft.diagnostics) {
    const k = `${d.code}|${d.message}|${d.sourceRef?.sourceId ?? ''}|${d.sourceRef?.line ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidate.diagnostics.push(d);
  }

  // Map setpoint bindings to equipment candidates. Source-side
  // equipment ids are typically raw CSV tags (e.g. `mot01`); the
  // candidate's id is `eq_${node.id}` where the device node id
  // is `device:mot01`. We index by both shapes for robustness.
  if (Object.keys(draft.setpointBindings).length === 0) return;

  const eqByRawTag = new Map<string, PirEquipmentCandidate>();
  for (const eq of candidate.equipment) {
    eqByRawTag.set(eq.id, eq);
    // Strip the candidate-side `eq_device:` / `eq_` prefix the
    // candidate mapper added (see Pass 2: `id: \`eq_${n.id}\``,
    // and CSV node ids start with `device:`).
    const stripped = eq.id
      .replace(/^eq_device:/, '')
      .replace(/^eq_/, '');
    if (stripped.length > 0) eqByRawTag.set(stripped, eq);
  }

  for (const [equipmentId, roleMap] of Object.entries(draft.setpointBindings)) {
    const eq = eqByRawTag.get(equipmentId);
    if (!eq) {
      candidate.diagnostics.push(
        createElectricalDiagnostic({
          code: 'CSV_SETPOINT_BINDING_TARGET_MISSING',
          message: `CSV setpoint_binding referenced equipment ${JSON.stringify(equipmentId)} but no matching equipment candidate exists in the draft (the device-row may have failed classification or was emitted as an assumption).`,
          hint: 'declare the equipment as a CSV device row (e.g. tag=mot01, kind=motor_vfd_simple) before binding parameters to it.',
        }),
      );
      continue;
    }
    const next: Record<string, string> = { ...(eq.ioSetpointBindings ?? {}) };
    for (const [role, paramId] of Object.entries(roleMap)) {
      next[role] = paramId;
    }
    eq.ioSetpointBindings = next;
  }
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

// Sprint 86 — Codegen readiness / preflight diagnostics v0.
//
// Pure / DOM-free / total. The Sprint 76+ pipeline funnels every
// target (Siemens / CODESYS / Rockwell) through `compileProject`
// in codegen-core, which throws on the first scope-check failure
// (`UNSUPPORTED_EQUIPMENT`, `NO_MACHINE`). Operators saw a single
// error per generation attempt — useful, but it hides every
// other issue lurking in the same PIR.
//
// Sprint 86 adds a *preflight* readiness layer that runs ahead
// of `compileProject` in each target's entry point:
//
//   1. `preflightProject` walks the project once and collects
//      ALL readiness issues into a deterministic
//      `Diagnostic[]` — not just the first.
//
//   2. Per-target capability tables narrow the supported set
//      below `compileProject`'s default. A target can decide
//      which equipment kinds / IO data types / IO memory areas
//      it actually emits today; the readiness pass surfaces a
//      precise diagnostic for anything outside that set.
//
//   3. The output is purely informational. Targets choose
//      whether to throw on `error` severity (Sprint 86 wires
//      Siemens / CODESYS / Rockwell to throw a single
//      `READINESS_FAILED` error carrying the collected
//      diagnostics) or to surface them in their manifest.
//
// Hard rules:
//   - No mutation of the input PIR project.
//   - No new buildable evidence — readiness never invents code.
//   - No automatic merging or renaming on duplicates.
//   - No assumption promotion.
//   - Pure / total. Returns a sorted, deduplicated list.

import type {
  Equipment,
  EquipmentType,
  IoSignal,
  Machine,
  MemoryArea,
  Project,
  SignalDataType,
  Station,
} from '@plccopilot/pir';

import {
  dedupDiagnostics,
  diag,
  sortDiagnostics,
  type Diagnostic,
} from '../compiler/diagnostics.js';
import {
  equipmentPath,
  equipmentTypePath,
  stationPath,
} from '../compiler/diagnostic-paths.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Sprint 86 — codegen targets supported by the readiness layer.
 * `'core'` is the vendor-neutral default and matches
 * `compileProject`'s built-in scope check; the per-target values
 * narrow the supported set below the core baseline.
 */
export type CodegenTarget = 'core' | 'siemens' | 'codesys' | 'rockwell';

/**
 * Sprint 86 — per-target capability table. Empty / undefined
 * fields use the core defaults; a target can therefore declare
 * only the dimensions it cares about.
 */
export interface TargetCapabilities {
  /** Target id this capability set describes. */
  target: CodegenTarget;
  /** Equipment kinds the target can emit safely. */
  supportedEquipmentTypes: ReadonlySet<EquipmentType>;
  /** IO data types the target can address in generated artifacts. */
  supportedIoDataTypes: ReadonlySet<SignalDataType>;
  /** PIR `MemoryArea`s the target can render. */
  supportedIoMemoryAreas: ReadonlySet<MemoryArea>;
}

export interface PreflightOptions {
  /**
   * Target whose capability table is consulted. Defaults to
   * `'core'` — equivalent to `compileProject`'s scope check.
   */
  target?: CodegenTarget;
  /**
   * Override capability table. When supplied, fully replaces
   * the per-target default; mainly useful for tests + future
   * vendor extensions.
   */
  capabilities?: TargetCapabilities;
}

export interface PreflightResult {
  /** Target the readiness pass was run against. */
  target: CodegenTarget;
  /**
   * Sorted, deduplicated diagnostic list. `severity: 'error'`
   * entries are blocking — targets MUST refuse generation
   * (typically by throwing `CodegenError('READINESS_FAILED', …)`
   * with the diagnostic list attached). `'warning'` and
   * `'info'` are non-blocking and may be propagated into the
   * manifest.
   */
  diagnostics: Diagnostic[];
  /** True iff at least one diagnostic has `severity === 'error'`. */
  hasBlockingErrors: boolean;
}

// ---------------------------------------------------------------------------
// Per-target capability defaults
// ---------------------------------------------------------------------------

// Sprint 86 baseline narrow set is no longer used directly.
// Sprint 87A widened CODESYS, Sprint 87C widened Siemens after
// the SCL renderer audit, and Sprint 88C widens Rockwell after
// the Logix renderer audit. All four targets now share
// `CORE_SUPPORTED_EQUIPMENT`. The narrow constant can be
// re-introduced when a future kind lands on a subset of
// targets.

// Sprint 87A — `core` and `codesys` widen the supported set with
// `valve_onoff`. The vendor-neutral lowering ships
// `wireValveOnoff` + `UDT_ValveOnoff`, so anything that goes
// through `compileProject` directly (codegen-core unit tests,
// CODESYS façade) accepts it. Siemens / Rockwell façades reject
// it via `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET` — those
// targets have not been verified to render valve_onoff safely.
const CORE_SUPPORTED_EQUIPMENT: ReadonlySet<EquipmentType> = new Set<EquipmentType>([
  'pneumatic_cylinder_2pos',
  'motor_simple',
  'sensor_discrete',
  'valve_onoff',
]);

const CORE_SUPPORTED_DATA_TYPES: ReadonlySet<SignalDataType> = new Set<SignalDataType>([
  'bool',
  'int',
  'dint',
  'real',
]);

const CORE_SUPPORTED_MEMORY_AREAS: ReadonlySet<MemoryArea> = new Set<MemoryArea>([
  'I',
  'Q',
  'M',
  'DB',
]);

const TARGET_CAPABILITIES: Record<CodegenTarget, TargetCapabilities> = {
  core: {
    target: 'core',
    // Mirrors `compileProject`'s widened SUPPORTED_TYPES.
    supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
    supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
    supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
  },
  siemens: {
    target: 'siemens',
    // Sprint 87C — Siemens widens to match `core` after the SCL
    // renderer audit confirmed it is structurally agnostic
    // (`buildEquipmentTypesIR` walks core's `FIELDS` table;
    // `wireValveOnoff` produces standard StmtIR). Siemens now
    // ships v0 `valve_onoff` support alongside CODESYS.
    supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
    supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
    supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
  },
  codesys: {
    target: 'codesys',
    // Sprint 87A — CODESYS renders `valve_onoff` via the shared
    // ProgramIR pipeline.
    supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
    supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
    supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
  },
  rockwell: {
    target: 'rockwell',
    // Sprint 88C — Rockwell widens to match `core` after the
    // Logix renderer audit confirmed it is structurally
    // agnostic (UDT rendering iterates `TypeArtifactIR.fields`
    // blindly; `Assign` StmtIR renders as `target := expr;`
    // with no per-equipment branch; no `UDT_NAMES` mapping
    // exists — canonical names flow through `core`). Rockwell
    // now ships v0 `valve_onoff` support alongside CODESYS and
    // Siemens.
    supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
    supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
    supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
  },
};

/**
 * Sprint 86 — public capability lookup for tests + targets that
 * want to extend the table at the call site.
 */
export function getTargetCapabilities(
  target: CodegenTarget,
): TargetCapabilities {
  return TARGET_CAPABILITIES[target];
}

// ---------------------------------------------------------------------------
// preflightProject
// ---------------------------------------------------------------------------

/**
 * Sprint 86 — run the readiness pass on a PIR project.
 *
 * Pure / total / no mutation. Walks every machine → station →
 * equipment / io / sequence and collects:
 *
 *   - empty PIR (no machines)
 *   - machines with zero equipment / zero IO
 *   - equipment with type outside the target capability set
 *   - IO with data type / memory area outside the target set
 *   - duplicate equipment ids (within a machine)
 *   - duplicate IO ids (within a machine)
 *   - duplicate IO addresses (memory_area+byte+bit, within a machine)
 *   - duplicate generated symbols (equipment.code_symbol)
 *   - placeholder sequences (one transition `init` → `terminal`,
 *     the Sprint 76 v0 stub)
 *   - per-equipment object-skipped notes when `compileProject`
 *     would skip them silently
 *
 * Returns a `PreflightResult` with `diagnostics` sorted via
 * `sortDiagnostics`. Callers decide how to surface or escalate.
 */
export function preflightProject(
  project: Project | undefined | null,
  options: PreflightOptions = {},
): PreflightResult {
  const target: CodegenTarget = options.target ?? 'core';
  const capabilities =
    options.capabilities ?? TARGET_CAPABILITIES[target];

  const diagnostics: Diagnostic[] = [];

  if (!project || typeof project !== 'object') {
    diagnostics.push(
      diag('error', 'READINESS_PIR_EMPTY', 'PIR project is missing.', {
        path: '',
        hint: 'Pass a non-null PIR Project before invoking codegen.',
      }),
    );
    return finaliseResult(target, diagnostics);
  }

  const machines = Array.isArray(project.machines) ? project.machines : [];
  if (machines.length === 0) {
    diagnostics.push(
      diag('error', 'READINESS_PIR_EMPTY', 'PIR project has no machines.', {
        path: 'machines',
        hint: 'Add at least one machine to the PIR project before invoking codegen.',
      }),
    );
    return finaliseResult(target, diagnostics);
  }

  for (let mi = 0; mi < machines.length; mi++) {
    const machine = machines[mi];
    if (!machine) continue;
    walkMachine(machine, mi, capabilities, diagnostics);
  }

  return finaliseResult(target, diagnostics);
}

function finaliseResult(
  target: CodegenTarget,
  diagnostics: Diagnostic[],
): PreflightResult {
  const sorted = sortDiagnostics(dedupDiagnostics(diagnostics));
  const hasBlockingErrors = sorted.some((d) => d.severity === 'error');
  return { target, diagnostics: sorted, hasBlockingErrors };
}

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

function walkMachine(
  machine: Machine,
  machineIndex: number,
  capabilities: TargetCapabilities,
  out: Diagnostic[],
): void {
  const equipmentByMachine = new Map<string, Equipment[]>();
  const ioByAddress = new Map<string, IoSignal[]>();
  const ioById = new Map<string, IoSignal[]>();
  const generatedSymbolByMachine = new Map<string, Equipment[]>();

  // ---- IO walk ----
  const ioList = Array.isArray(machine.io) ? machine.io : [];
  if (ioList.length === 0) {
    out.push(
      diag(
        'info',
        'READINESS_NO_GENERATABLE_OBJECTS',
        `Machine ${JSON.stringify(machine.id)} has no IO signals; codegen will produce no IO tables.`,
        {
          path: `machines[${machineIndex}].io`,
        },
      ),
    );
  }
  for (const io of ioList) {
    if (!io || typeof io !== 'object') continue;
    pushMapList(ioById, io.id, io);
    const addr = ioAddressKey(io);
    if (addr.length > 0) pushMapList(ioByAddress, addr, io);

    if (
      typeof io.data_type === 'string' &&
      !capabilities.supportedIoDataTypes.has(io.data_type as SignalDataType)
    ) {
      out.push(
        diag(
          'error',
          'READINESS_UNSUPPORTED_IO_DATA_TYPE',
          `IO ${JSON.stringify(io.id)} has data_type ${JSON.stringify(io.data_type)}, ` +
            `which target ${capabilities.target} does not support today.`,
          {
            path: `machines[${machineIndex}].io[*]`,
            symbol: io.id,
            hint: `Supported data types for ${capabilities.target}: ${formatSet(capabilities.supportedIoDataTypes)}.`,
          },
        ),
      );
    }
    const area = io.address?.memory_area as MemoryArea | undefined;
    if (
      typeof area === 'string' &&
      !capabilities.supportedIoMemoryAreas.has(area)
    ) {
      out.push(
        diag(
          'error',
          'READINESS_UNSUPPORTED_IO_MEMORY_AREA',
          `IO ${JSON.stringify(io.id)} uses memory area ${JSON.stringify(area)}, ` +
            `which target ${capabilities.target} does not support today.`,
          {
            path: `machines[${machineIndex}].io[*]`,
            symbol: io.id,
            hint: `Supported memory areas for ${capabilities.target}: ${formatSet(capabilities.supportedIoMemoryAreas)}.`,
          },
        ),
      );
    }
  }

  // Duplicate IO ids — one warning per group.
  for (const [id, group] of ioById) {
    if (group.length > 1) {
      out.push(
        diag(
          'warning',
          'READINESS_DUPLICATE_IO_ID',
          `Machine ${JSON.stringify(machine.id)} has ${group.length} IO signals sharing id ${JSON.stringify(id)}; ` +
            `codegen will emit conflicting tag rows.`,
          {
            path: `machines[${machineIndex}].io[*]`,
            symbol: id,
          },
        ),
      );
    }
  }
  // Duplicate IO addresses — one warning per group.
  for (const [key, group] of ioByAddress) {
    if (group.length > 1) {
      out.push(
        diag(
          'warning',
          'READINESS_DUPLICATE_IO_ADDRESS',
          `Machine ${JSON.stringify(machine.id)} has ${group.length} IO signals at the same address ` +
            `(${key}); codegen will not silently merge them.`,
          {
            path: `machines[${machineIndex}].io[*]`,
            symbol: group[0].id,
          },
        ),
      );
    }
  }

  // ---- Station / equipment walk ----
  const stations = Array.isArray(machine.stations) ? machine.stations : [];
  if (stations.length === 0) {
    out.push(
      diag(
        'info',
        'READINESS_NO_GENERATABLE_OBJECTS',
        `Machine ${JSON.stringify(machine.id)} has no stations; codegen will produce no station FBs.`,
        {
          path: `machines[${machineIndex}].stations`,
        },
      ),
    );
  }
  for (let si = 0; si < stations.length; si++) {
    const station = stations[si];
    if (!station) continue;
    walkStation(
      station,
      machineIndex,
      si,
      capabilities,
      equipmentByMachine,
      generatedSymbolByMachine,
      out,
    );
  }

  // Duplicate equipment ids across the machine.
  for (const [id, group] of equipmentByMachine) {
    if (group.length > 1) {
      out.push(
        diag(
          'warning',
          'READINESS_DUPLICATE_EQUIPMENT_ID',
          `Machine ${JSON.stringify(machine.id)} has ${group.length} equipment instances sharing id ${JSON.stringify(id)}.`,
          {
            path: `machines[${machineIndex}].stations[*].equipment[*]`,
            symbol: id,
          },
        ),
      );
    }
  }
  // Duplicate generated `code_symbol`s — same equipment id may
  // legitimately appear in two stations under different symbols,
  // but two distinct equipment ids using the same `code_symbol`
  // collide in the generated tag namespace.
  for (const [symbolKey, group] of generatedSymbolByMachine) {
    const distinctIds = new Set(group.map((eq) => eq.id));
    if (distinctIds.size > 1) {
      out.push(
        diag(
          'warning',
          'READINESS_DUPLICATE_GENERATED_SYMBOL',
          `Machine ${JSON.stringify(machine.id)} has ${distinctIds.size} distinct equipment ids ` +
            `that all render to symbol ${JSON.stringify(symbolKey)}; codegen will collide.`,
          {
            path: `machines[${machineIndex}].stations[*].equipment[*]`,
            symbol: symbolKey,
          },
        ),
      );
    }
  }
}

function walkStation(
  station: Station,
  machineIndex: number,
  stationIndex: number,
  capabilities: TargetCapabilities,
  equipmentByMachine: Map<string, Equipment[]>,
  generatedSymbolByMachine: Map<string, Equipment[]>,
  out: Diagnostic[],
): void {
  const equipment = Array.isArray(station.equipment) ? station.equipment : [];
  if (equipment.length === 0) {
    out.push(
      diag(
        'info',
        'READINESS_NO_GENERATABLE_OBJECTS',
        `Station ${JSON.stringify(station.id)} has no equipment; codegen will produce no station FB body.`,
        {
          path: stationPath(machineIndex, stationIndex),
          stationId: station.id,
        },
      ),
    );
  }
  for (let ei = 0; ei < equipment.length; ei++) {
    const eq = equipment[ei];
    if (!eq) continue;
    pushMapList(equipmentByMachine, eq.id, eq);
    if (typeof eq.code_symbol === 'string' && eq.code_symbol.length > 0) {
      pushMapList(generatedSymbolByMachine, eq.code_symbol, eq);
    }
    if (!capabilities.supportedEquipmentTypes.has(eq.type)) {
      out.push(
        diag(
          'error',
          'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
          `Equipment ${JSON.stringify(eq.id)} has type ${JSON.stringify(eq.type)}, ` +
            `which target ${capabilities.target} does not support today.`,
          {
            path: equipmentTypePath(machineIndex, stationIndex, ei),
            stationId: station.id,
            symbol: eq.id,
            hint: `Supported equipment kinds for ${capabilities.target}: ` +
              `${formatSet(capabilities.supportedEquipmentTypes)}. ` +
              `Either change ${eq.id}.type or skip this equipment via review.`,
          },
        ),
      );
    }
  }

  // Sequence checks — the Sprint 76 placeholder is two states
  // (`init` + `terminal`) plus one transition. Detect that
  // shape and surface an info diagnostic so the operator knows
  // the generated state machine is a no-op.
  const seq = station.sequence;
  if (seq && Array.isArray(seq.states) && Array.isArray(seq.transitions)) {
    const states = seq.states;
    const transitions = seq.transitions;
    if (
      states.length <= 2 &&
      transitions.length <= 1 &&
      states.some((s) => s?.id === 'init') &&
      states.some((s) => s?.id === 'terminal')
    ) {
      out.push(
        diag(
          'info',
          'READINESS_PLACEHOLDER_SEQUENCE',
          `Station ${JSON.stringify(station.id)} carries the Sprint 76 placeholder sequence ` +
            `(init → terminal); codegen will emit a no-op state machine.`,
          {
            path: `${stationPath(machineIndex, stationIndex)}.sequence`,
            stationId: station.id,
          },
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ioAddressKey(io: IoSignal): string {
  const a = io.address;
  if (!a || typeof a !== 'object') return '';
  const parts: string[] = [];
  if (typeof a.memory_area === 'string') parts.push(`area=${a.memory_area}`);
  if (typeof a.byte === 'number') parts.push(`byte=${a.byte}`);
  if (typeof a.bit === 'number') parts.push(`bit=${a.bit}`);
  if (typeof a.db_number === 'number') parts.push(`db=${a.db_number}`);
  return parts.join('|');
}

function pushMapList<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function formatSet<T extends string>(set: ReadonlySet<T>): string {
  return Array.from(set).sort().map((s) => JSON.stringify(s)).join(', ');
}

// `equipmentPath` is exported from the diagnostic-paths module
// and used by callers that want to point at a single equipment
// row. We re-export it here so the readiness module is self-
// contained for downstream targets.
export { equipmentPath, equipmentTypePath, stationPath };

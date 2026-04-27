import type {
  Alarm,
  Equipment,
  Interlock,
  IoAddress,
  IoSignal,
  Machine,
  Project,
  SafetyGroup,
  Station,
} from '@plccopilot/pir';

// =============================================================================
// Pointer types — what the structure-tree refs become after resolution.
// =============================================================================

export interface ResolvedIoBindingSignal {
  id: string;
  displayName: string;
  /** Human-readable address (`Q0.0`, `DB100.4`, …). Independent of vendor. */
  addressRaw: string;
  dtype: string;
  direction: string;
}

export interface ResolvedIoBinding {
  role: string;
  ioId: string;
  found: boolean;
  signal?: ResolvedIoBindingSignal;
}

export interface EquipmentRelations {
  bindings: ResolvedIoBinding[];
  alarms: Alarm[];
  interlocks: Interlock[];
  safetyGroups: SafetyGroup[];
}

export interface StationSequenceSummary {
  states: number;
  transitions: number;
  initialState?: string;
  terminalStates: string[];
}

export interface StationRelations {
  equipment: Equipment[];
  alarms: Alarm[];
  interlocks: Interlock[];
  safetyGroups: SafetyGroup[];
  sequence?: StationSequenceSummary;
}

export interface MachineSummary {
  modes: number;
  stations: number;
  equipment: number;
  io: number;
  alarms: number;
  interlocks: number;
  parameters: number;
  recipes: number;
  safetyGroups: number;
  inputs: number;
  outputs: number;
  /** EquipmentType → count, in iteration order across stations. */
  equipmentTypeCount: Record<string, number>;
}

// =============================================================================
// Index lookups — pure dereferences, return null when out of range.
// =============================================================================

export function getMachineByIndex(
  project: Project,
  machineIndex: number,
): Machine | null {
  if (!Number.isInteger(machineIndex) || machineIndex < 0) return null;
  return project.machines[machineIndex] ?? null;
}

export function getStationByPath(
  project: Project,
  machineIndex: number,
  stationIndex: number,
): Station | null {
  const m = getMachineByIndex(project, machineIndex);
  if (!m) return null;
  if (!Number.isInteger(stationIndex) || stationIndex < 0) return null;
  return m.stations[stationIndex] ?? null;
}

export function getEquipmentByPath(
  project: Project,
  machineIndex: number,
  stationIndex: number,
  equipmentIndex: number,
): Equipment | null {
  const s = getStationByPath(project, machineIndex, stationIndex);
  if (!s) return null;
  if (!Number.isInteger(equipmentIndex) || equipmentIndex < 0) return null;
  return s.equipment[equipmentIndex] ?? null;
}

// =============================================================================
// Address formatting — vendor-neutral, matches the convention the codegen
// backends use to print IO addresses in generated artifacts.
// =============================================================================

export function formatIoAddress(addr: IoAddress): string {
  const bitSeg = typeof addr.bit === 'number' ? `.${addr.bit}` : '';
  if (addr.memory_area === 'DB') {
    const db = typeof addr.db_number === 'number' ? `DB${addr.db_number}` : 'DB?';
    return `${db}.${addr.byte}${bitSeg}`;
  }
  return `${addr.memory_area}${addr.byte}${bitSeg}`;
}

// =============================================================================
// IO bindings — one row per equipment role. Missing IO ids surface as
// `found: false` so the UI can flag them without throwing.
// =============================================================================

export function resolveIoBinding(
  machine: Machine,
  equipment: Equipment,
): ResolvedIoBinding[] {
  const ioById = new Map<string, IoSignal>();
  for (const s of machine.io) ioById.set(s.id, s);

  const bindingsRec =
    (equipment as unknown as Record<string, unknown>).io_bindings &&
    typeof (equipment as unknown as Record<string, unknown>).io_bindings ===
      'object' &&
    !Array.isArray(
      (equipment as unknown as Record<string, unknown>).io_bindings,
    )
      ? (equipment.io_bindings as Record<string, string>)
      : {};

  const out: ResolvedIoBinding[] = [];
  for (const [role, ioId] of Object.entries(bindingsRec)) {
    const sig = ioById.get(ioId);
    if (sig) {
      out.push({
        role,
        ioId,
        found: true,
        signal: {
          id: sig.id,
          displayName: sig.name,
          addressRaw: formatIoAddress(sig.address),
          dtype: sig.data_type,
          direction: sig.direction,
        },
      });
    } else {
      out.push({ role, ioId, found: false });
    }
  }
  // Deterministic display ordering — independent of property iteration order.
  out.sort((a, b) => a.role.localeCompare(b.role));
  return out;
}

// =============================================================================
// Equipment relations
// =============================================================================

export function resolveEquipmentRelations(
  project: Project,
  machineIndex: number,
  stationIndex: number,
  equipmentIndex: number,
): EquipmentRelations | null {
  const machine = getMachineByIndex(project, machineIndex);
  const station = getStationByPath(project, machineIndex, stationIndex);
  const equipment = getEquipmentByPath(
    project,
    machineIndex,
    stationIndex,
    equipmentIndex,
  );
  if (!machine || !station || !equipment) return null;

  const bindings = resolveIoBinding(machine, equipment);

  // Alarm.equipment_id is a vendor extension — not in core schema. Read it
  // defensively via Record cast so the resolver works on both core and
  // extended PIRs without forcing a schema change.
  const alarms = machine.alarms.filter((a) => {
    const rec = a as unknown as Record<string, unknown>;
    return rec.equipment_id === equipment.id;
  });

  // Interlocks: `inhibits` carries dotted refs like `cyl01.extend`. We match
  // on the prefix `<eq.id>.` so distinct ids that share a substring (e.g.
  // `mot01a` vs `mot01`) don't cross-match.
  const interlocks = machine.interlocks.filter((il) =>
    il.inhibits.startsWith(`${equipment.id}.`),
  );

  // Safety groups — primary path is `affects: [{ kind:'equipment', equipment_id }]`
  // (core schema). Fallback: `equipment.safety_group_ids` (vendor extension)
  // listing group ids directly. Either signal qualifies as "related".
  const eqRec = equipment as unknown as Record<string, unknown>;
  const sgIds = Array.isArray(eqRec.safety_group_ids)
    ? (eqRec.safety_group_ids as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      )
    : null;

  const safetyGroups = machine.safety_groups.filter((sg) => {
    if (sgIds && sgIds.includes(sg.id)) return true;
    return sg.affects.some(
      (a) => a.kind === 'equipment' && a.equipment_id === equipment.id,
    );
  });

  return { bindings, alarms, interlocks, safetyGroups };
}

// =============================================================================
// Station relations
// =============================================================================

export function resolveStationRelations(
  project: Project,
  machineIndex: number,
  stationIndex: number,
): StationRelations | null {
  const machine = getMachineByIndex(project, machineIndex);
  const station = getStationByPath(project, machineIndex, stationIndex);
  if (!machine || !station) return null;

  const equipmentIds = new Set(station.equipment.map((e) => e.id));

  // Alarm.station_id is a vendor extension — same pattern as equipment_id.
  const alarms = machine.alarms.filter((a) => {
    const rec = a as unknown as Record<string, unknown>;
    return rec.station_id === station.id;
  });

  // Interlocks at the station level: inhibits whose `<eqId>.` prefix names
  // any equipment that lives in this station.
  const interlocks = machine.interlocks.filter((il) => {
    const dot = il.inhibits.indexOf('.');
    if (dot < 0) return false;
    const head = il.inhibits.slice(0, dot);
    return equipmentIds.has(head);
  });

  // Safety groups: direct station target OR any equipment-target inside this
  // station qualifies. The two predicates are joined with OR so a group that
  // only references one piece of equipment still surfaces here.
  const safetyGroups = machine.safety_groups.filter((sg) =>
    sg.affects.some(
      (a) =>
        (a.kind === 'station' && a.station_id === station.id) ||
        (a.kind === 'equipment' && equipmentIds.has(a.equipment_id)),
    ),
  );

  const sequence = summarizeSequence(station);

  return {
    equipment: station.equipment.slice(),
    alarms,
    interlocks,
    safetyGroups,
    sequence,
  };
}

function summarizeSequence(station: Station): StationSequenceSummary | undefined {
  const stRec = station as unknown as {
    sequence?: { states?: unknown[]; transitions?: unknown[] };
  };
  const seq = stRec.sequence;
  if (!seq || (!Array.isArray(seq.states) && !Array.isArray(seq.transitions))) {
    return undefined;
  }
  const states = Array.isArray(seq.states) ? seq.states : [];
  const transitions = Array.isArray(seq.transitions) ? seq.transitions : [];

  // `kind === 'initial' | 'terminal'` is the canonical schema; we also accept
  // boolean `initial` / `terminal` flags as a vendor-extension fallback.
  let initialState: string | undefined;
  const terminalStates: string[] = [];
  for (const raw of states) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id : null;
    if (!id) continue;
    if (s.kind === 'initial' || s.initial === true) {
      // Pick the first one; multiple initial states is a schema violation
      // surfaced elsewhere in the validation pipeline.
      if (!initialState) initialState = id;
    }
    if (s.kind === 'terminal' || s.terminal === true) {
      terminalStates.push(id);
    }
  }

  return {
    states: states.length,
    transitions: transitions.length,
    initialState,
    terminalStates,
  };
}

// =============================================================================
// Machine summary — counters + histograms.
// =============================================================================

export function resolveMachineSummary(
  project: Project,
  machineIndex: number,
): MachineSummary | null {
  const machine = getMachineByIndex(project, machineIndex);
  if (!machine) return null;

  let inputs = 0;
  let outputs = 0;
  for (const s of machine.io) {
    if (s.direction === 'in') inputs++;
    else if (s.direction === 'out') outputs++;
  }

  let equipment = 0;
  const typeCount: Record<string, number> = {};
  for (const station of machine.stations) {
    for (const eq of station.equipment) {
      equipment++;
      typeCount[eq.type] = (typeCount[eq.type] ?? 0) + 1;
    }
  }

  // `modes` is a vendor extension on Machine — surface its length when it
  // is present, otherwise report 0 so downstream rendering is uniform.
  const mRec = machine as unknown as Record<string, unknown>;
  const modes = Array.isArray(mRec.modes)
    ? (mRec.modes as unknown[]).length
    : 0;

  return {
    modes,
    stations: machine.stations.length,
    equipment,
    io: machine.io.length,
    alarms: machine.alarms.length,
    interlocks: machine.interlocks.length,
    parameters: machine.parameters.length,
    recipes: machine.recipes.length,
    safetyGroups: machine.safety_groups.length,
    inputs,
    outputs,
    equipmentTypeCount: typeCount,
  };
}

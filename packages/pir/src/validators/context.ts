import type {
  Alarm,
  Equipment,
  Interlock,
  IoSignal,
  Machine,
  Parameter,
  Project,
  Recipe,
  SafetyGroup,
  Sequence,
  Station,
} from '../domain/types.js';

export interface ValidationContext {
  project: Project;
  machine: Machine;
  stations_by_id: Map<string, Station>;
  equipment_by_id: Map<string, Equipment>;
  io_by_id: Map<string, IoSignal>;
  io_by_raw_address: Map<string, IoSignal[]>;
  alarms_by_id: Map<string, Alarm>;
  interlocks_by_id: Map<string, Interlock>;
  parameters_by_id: Map<string, Parameter>;
  recipes_by_id: Map<string, Recipe>;
  safety_groups_by_id: Map<string, SafetyGroup>;
  sequences: { station: Station; sequence: Sequence }[];
}

export function rawAddress(signal: IoSignal): string {
  const a = signal.address;
  const base =
    a.memory_area === 'DB'
      ? `DB${a.db_number ?? '?'}.${a.byte}`
      : `${a.memory_area}${a.byte}`;
  return a.bit !== undefined ? `${base}.${a.bit}` : base;
}

export function buildContext(project: Project): ValidationContext {
  const machine = project.machines[0] as Machine;
  const ctx: ValidationContext = {
    project,
    machine,
    stations_by_id: new Map(),
    equipment_by_id: new Map(),
    io_by_id: new Map(),
    io_by_raw_address: new Map(),
    alarms_by_id: new Map(),
    interlocks_by_id: new Map(),
    parameters_by_id: new Map(),
    recipes_by_id: new Map(),
    safety_groups_by_id: new Map(),
    sequences: [],
  };

  for (const s of machine.stations) {
    if (!ctx.stations_by_id.has(s.id)) ctx.stations_by_id.set(s.id, s);
    for (const e of s.equipment) {
      if (!ctx.equipment_by_id.has(e.id)) ctx.equipment_by_id.set(e.id, e);
    }
    ctx.sequences.push({ station: s, sequence: s.sequence });
  }

  for (const io of machine.io) {
    if (!ctx.io_by_id.has(io.id)) ctx.io_by_id.set(io.id, io);
    const raw = rawAddress(io);
    const list = ctx.io_by_raw_address.get(raw);
    if (list) list.push(io);
    else ctx.io_by_raw_address.set(raw, [io]);
  }

  for (const a of machine.alarms) {
    if (!ctx.alarms_by_id.has(a.id)) ctx.alarms_by_id.set(a.id, a);
  }
  for (const i of machine.interlocks) {
    if (!ctx.interlocks_by_id.has(i.id)) ctx.interlocks_by_id.set(i.id, i);
  }
  for (const p of machine.parameters) {
    if (!ctx.parameters_by_id.has(p.id)) ctx.parameters_by_id.set(p.id, p);
  }
  for (const r of machine.recipes) {
    if (!ctx.recipes_by_id.has(r.id)) ctx.recipes_by_id.set(r.id, r);
  }
  for (const g of machine.safety_groups) {
    if (!ctx.safety_groups_by_id.has(g.id))
      ctx.safety_groups_by_id.set(g.id, g);
  }

  return ctx;
}

export function machinePath(_context: ValidationContext): string {
  return `$.machines[0]`;
}

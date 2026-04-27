import type { Equipment, IoSignal, Machine, Station } from '@plccopilot/pir';
import { EXPR_KEYWORDS, parseEquipmentRoleRef } from '@plccopilot/pir';
import { CodegenError } from '../types.js';

export interface SymbolContext {
  machine: Machine;
  station: Station;
  io_by_id: Map<string, IoSignal>;
  equipment_by_id: Map<string, Equipment>;
  parameter_ids: Set<string>;
  alarm_ids: Set<string>;
  path: string;
}

export function buildSymbolContext(
  machine: Machine,
  station: Station,
  path: string,
): SymbolContext {
  const io_by_id = new Map<string, IoSignal>();
  for (const io of machine.io) io_by_id.set(io.id, io);

  const equipment_by_id = new Map<string, Equipment>();
  for (const s of machine.stations) {
    for (const e of s.equipment) equipment_by_id.set(e.id, e);
  }

  return {
    machine,
    station,
    io_by_id,
    equipment_by_id,
    parameter_ids: new Set(machine.parameters.map((p) => p.id)),
    alarm_ids: new Set(machine.alarms.map((a) => a.id)),
    path,
  };
}

const KNOWN_KEYWORDS: readonly string[] = [
  'mode',
  'start_cmd',
  'release_cmd',
  'estop_active',
  'auto',
  'manual',
  'setup',
  'maintenance',
  'true',
  'false',
];

export function renderKeyword(kw: string): string {
  switch (kw) {
    case 'mode':
      return '#i_mode';
    case 'start_cmd':
      return '#i_start_cmd';
    case 'release_cmd':
      return '#i_release_cmd';
    case 'estop_active':
      return '#i_estop_active';
    case 'auto':
      return '1';
    case 'manual':
      return '2';
    case 'setup':
      return '3';
    case 'maintenance':
      return '4';
    case 'true':
      return 'TRUE';
    case 'false':
      return 'FALSE';
    default:
      // Sprint 40 — surface the offending keyword as `symbol` so the
      // CLI / web banner show it as a metadata chip, plus enumerate
      // the valid set so the integrator doesn't have to grep.
      throw new CodegenError(
        'UNKNOWN_KEYWORD',
        `Unknown keyword "${kw}".`,
        {
          symbol: kw,
          hint: `Use one of the supported keywords: ${KNOWN_KEYWORDS.join(', ')}.`,
        },
      );
  }
}

export function resolveToSclSymbol(ref: string, ctx: SymbolContext): string {
  if (EXPR_KEYWORDS.has(ref)) return renderKeyword(ref);

  if (ref.includes('.')) {
    const parsed = parseEquipmentRoleRef(ref);
    if (!parsed) {
      // Sprint 40 — invalid `equipment.role` shape (e.g. extra dots,
      // empty parts). Surface the ref as `symbol` and the station
      // scope; hint nudges the user toward the canonical form.
      throw new CodegenError(
        'INVALID_REF',
        `Reference "${ref}" has an invalid format.`,
        {
          path: ctx.path,
          stationId: ctx.station.id,
          symbol: ref,
          hint: 'Use "equipmentId.roleName" (e.g. "cyl01.signal_in") or a bare IO / parameter / alarm id.',
        },
      );
    }
    const eq = ctx.equipment_by_id.get(parsed.equipment_id);
    if (!eq) {
      throw new CodegenError(
        'UNKNOWN_EQUIPMENT',
        `Reference "${ref}" points to unknown equipment "${parsed.equipment_id}".`,
        {
          path: ctx.path,
          stationId: ctx.station.id,
          symbol: parsed.equipment_id,
          hint: 'Add the equipment to a station of the machine, or fix the referenced id.',
        },
      );
    }
    const ioId = eq.io_bindings[parsed.role];
    if (!ioId) {
      throw new CodegenError(
        'UNBOUND_ROLE',
        `Equipment "${parsed.equipment_id}" has no IO binding for role "${parsed.role}".`,
        {
          path: ctx.path,
          stationId: ctx.station.id,
          symbol: `${parsed.equipment_id}.${parsed.role}`,
          hint: `Bind "${parsed.role}" in equipment "${parsed.equipment_id}".io_bindings, or change the expression to reference a bound role.`,
        },
      );
    }
    const io = ctx.io_by_id.get(ioId);
    if (!io) {
      throw new CodegenError(
        'UNKNOWN_IO',
        `IO "${ioId}" bound to "${ref}" is not declared in machine.io.`,
        {
          path: ctx.path,
          stationId: ctx.station.id,
          symbol: ioId,
          hint: 'Add the IO signal to machine.io, or fix the binding to reference an existing IO id.',
        },
      );
    }
    return tagSymbol(io.id);
  }

  const io = ctx.io_by_id.get(ref);
  if (io) return tagSymbol(io.id);

  if (ctx.parameter_ids.has(ref)) return tagSymbol(ref);

  const eq = ctx.equipment_by_id.get(ref);
  if (eq) return tagSymbol(eq.id);

  throw new CodegenError(
    'UNRESOLVED_REF',
    `Reference "${ref}" does not resolve to any IO, parameter, equipment, or keyword.`,
    {
      path: ctx.path,
      stationId: ctx.station.id,
      symbol: ref,
      hint: 'Use an existing IO id, parameter id, alarm id, equipment id, or "equipmentId.role" reference.',
    },
  );
}

export function ioSymbolForRole(
  eq: Equipment,
  role: string,
  ctx: SymbolContext,
): string {
  const ioId = eq.io_bindings[role];
  if (!ioId) {
    throw new CodegenError(
      'UNBOUND_ROLE',
      `Equipment "${eq.id}" has no IO binding for role "${role}".`,
      {
        path: ctx.path,
        stationId: ctx.station.id,
        symbol: `${eq.id}.${role}`,
        hint: `Bind "${role}" in equipment "${eq.id}".io_bindings, or change the activity to use a bound role.`,
      },
    );
  }
  const io = ctx.io_by_id.get(ioId);
  if (!io) {
    throw new CodegenError(
      'UNKNOWN_IO',
      `IO "${ioId}" bound to "${eq.id}.${role}" is not declared in machine.io.`,
      {
        path: ctx.path,
        stationId: ctx.station.id,
        symbol: ioId,
        hint: 'Add the IO signal to machine.io, or fix the binding to reference an existing IO id.',
      },
    );
  }
  return tagSymbol(io.id);
}

export function tagSymbol(id: string): string {
  return `"${id}"`;
}

export function alarmSymbol(alarmId: string): string {
  return `"${alarmId}"`;
}

export function localSymbol(name: string): string {
  return `#${name}`;
}

import type {
  Alarm,
  IoSignal,
  Machine,
  Parameter,
  Project,
  Station,
} from '@plccopilot/pir';
import type { TagRowIR, TagTableArtifactIR } from './program.js';

/**
 * Vendor-neutral tag-table builder. Walks the PIR machine and produces the
 * canonical row list that every backend can render in its own format
 * (Siemens CSV, Codesys GVL list, Rockwell controller-tag table, …).
 *
 * The output carries:
 *   - logical names (no `siemens/`, no `.csv`)
 *   - canonical IR type spellings (`Bool` / `Int` / `DInt` / `Real` / `Variant`)
 *   - structured PIR addresses (no `%I0.0` rendering — that's vendor-specific)
 *
 * Alarms are intentionally NOT emitted as loose tag rows — they live in
 * `DB_Alarms` (or the equivalent for non-Siemens backends).
 */

const PIR_TO_CANONICAL: Record<string, string> = {
  bool: 'Bool',
  int: 'Int',
  dint: 'DInt',
  real: 'Real',
};

function canonicalType(t: string): string {
  return PIR_TO_CANONICAL[t] ?? 'Variant';
}

function ioRow(io: IoSignal): TagRowIR {
  return {
    name: io.id,
    dataType: canonicalType(io.data_type),
    ioAddress: io.address,
    comment: io.description ?? io.name,
    source: 'io',
  };
}

function parameterRow(p: Parameter): TagRowIR {
  const unitSuffix = p.unit ? ` [${p.unit}]` : '';
  return {
    name: p.id,
    dataType: canonicalType(p.data_type),
    comment: p.description ?? `${p.name}${unitSuffix}`,
    source: 'parameter',
  };
}

function stationStateRow(s: Station): TagRowIR {
  return {
    name: `${s.id}_state`,
    dataType: 'Int',
    comment: `Sequence state index of station ${s.name}`,
    source: 'station_state',
  };
}

function sortById<T extends { id: string }>(arr: readonly T[]): T[] {
  return arr.slice().sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build the canonical tag tables for a project. Currently produces a single
 * `Tags_Main` table aggregating I/O, parameters and station state words.
 * Future kinds (`io`, `internal`, `alarms`) can be added without breaking
 * the IR shape.
 */
export function buildTagTablesIR(project: Project): TagTableArtifactIR[] {
  const machine = project.machines[0] as Machine;
  const rows: TagRowIR[] = [];
  const seen = new Set<string>();

  const push = (row: TagRowIR): void => {
    if (seen.has(row.name)) return;
    seen.add(row.name);
    rows.push(row);
  };

  for (const io of sortById(machine.io)) push(ioRow(io));
  for (const p of sortById(machine.parameters)) push(parameterRow(p));
  // Alarms intentionally omitted — they belong to DB_Alarms.
  // Reference type to keep tsc strict happy if extended later.
  void (null as unknown as Alarm | null);
  for (const s of sortById(machine.stations)) push(stationStateRow(s));

  return [{ name: 'Tags_Main', kind: 'main', rows }];
}

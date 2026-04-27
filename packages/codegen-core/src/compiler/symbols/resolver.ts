import type { Machine, Station } from '@plccopilot/pir';
import { diag, type Diagnostic } from '../diagnostics.js';
import { SymbolTable } from './table.js';
import {
  pirToValueType,
  type ResolvedSymbol,
  type SymbolStorage,
  type ValueType,
} from './types.js';

export interface SymbolBuildResult {
  table: SymbolTable;
  diagnostics: Diagnostic[];
}

export interface BuildSymbolTableOptions {
  /** Defaults to `machine.alarms.length > 0`. */
  useDbAlarms?: boolean;
}

/**
 * Vendor-neutral storage for the PIR-Expr keyword set. The renderer chooses
 * `#i_mode` or `i_mode` depending on backend.
 */
const KEYWORD_SYMBOLS: ResolvedSymbol[] = [
  {
    pirName: 'mode',
    kind: 'keyword',
    valueType: 'int',
    storage: { kind: 'local', name: 'i_mode' },
  },
  {
    pirName: 'start_cmd',
    kind: 'keyword',
    valueType: 'bool',
    storage: { kind: 'local', name: 'i_start_cmd' },
  },
  {
    pirName: 'release_cmd',
    kind: 'keyword',
    valueType: 'bool',
    storage: { kind: 'local', name: 'i_release_cmd' },
  },
  {
    pirName: 'estop_active',
    kind: 'keyword',
    valueType: 'bool',
    storage: { kind: 'local', name: 'i_estop_active' },
  },
  {
    pirName: 'auto',
    kind: 'keyword',
    valueType: 'int',
    storage: { kind: 'literal', text: '1' },
  },
  {
    pirName: 'manual',
    kind: 'keyword',
    valueType: 'int',
    storage: { kind: 'literal', text: '2' },
  },
  {
    pirName: 'setup',
    kind: 'keyword',
    valueType: 'int',
    storage: { kind: 'literal', text: '3' },
  },
  {
    pirName: 'maintenance',
    kind: 'keyword',
    valueType: 'int',
    storage: { kind: 'literal', text: '4' },
  },
];

export function buildSymbolTable(
  machine: Machine,
  station: Station,
  options: BuildSymbolTableOptions = {},
): SymbolBuildResult {
  const table = new SymbolTable(station.id);
  const diagnostics: Diagnostic[] = [];

  const useDbAlarms = options.useDbAlarms ?? machine.alarms.length > 0;

  for (const k of KEYWORD_SYMBOLS) table.add(k);

  for (const io of machine.io) {
    table.add({
      pirName: io.id,
      kind: 'io',
      valueType: pirToValueType(io.data_type),
      storage: { kind: 'global', name: io.id },
    });
  }

  for (const p of machine.parameters) {
    table.add({
      pirName: p.id,
      kind: 'parameter',
      valueType: pirToValueType(p.data_type),
      storage: { kind: 'global', name: p.id },
    });
  }

  for (const al of machine.alarms) {
    const storage: SymbolStorage = useDbAlarms
      ? { kind: 'dbField', dbName: 'DB_Alarms', fieldName: `set_${al.id}` }
      : { kind: 'global', name: al.id };
    table.add({
      pirName: al.id,
      kind: 'alarm',
      valueType: 'bool',
      storage,
    });
  }

  // Equipment.role redirects to its bound IO global.
  for (const s of machine.stations) {
    for (const eq of s.equipment) {
      for (const [role, ioId] of Object.entries(eq.io_bindings)) {
        const io = machine.io.find((x) => x.id === ioId);
        if (!io) {
          diagnostics.push(
            diag(
              'error',
              'UNKNOWN_IO',
              `Equipment "${eq.id}" role "${role}" references unknown IO "${ioId}".`,
              {
                stationId: s.id,
                symbol: `${eq.id}.${role}`,
                hint: `Add IO "${ioId}" to machine.io, or change ${eq.id}.io_bindings.${role} to an existing IO id.`,
              },
            ),
          );
          continue;
        }
        table.add({
          pirName: `${eq.id}.${role}`,
          kind: 'equipment_role',
          valueType: pirToValueType(io.data_type),
          storage: { kind: 'global', name: io.id },
          stationId: s.id,
        });
      }
    }
  }

  return { table, diagnostics };
}

export function registerLocalCommand(
  table: SymbolTable,
  varName: string,
  valueType: ValueType = 'bool',
): ResolvedSymbol {
  const sym: ResolvedSymbol = {
    pirName: varName,
    kind: 'local',
    valueType,
    storage: { kind: 'local', name: varName },
    stationId: table.stationId,
  };
  table.add(sym);
  return sym;
}

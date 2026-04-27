export type SymbolKind =
  | 'io'
  | 'parameter'
  | 'alarm'
  | 'state'
  | 'equipment_role'
  | 'keyword'
  | 'local';

export type ValueType = 'bool' | 'int' | 'real' | 'string' | 'unknown';

/**
 * Vendor-neutral storage descriptor for a resolved symbol. The renderer
 * decides per-backend lexical conventions:
 *
 *   local    → `#name`     (Siemens) / `name`           (Codesys)
 *   global   → `"name"`    (Siemens) / `name`           (Codesys)
 *   dbField  → `"DB".f`    (Siemens) / `GVL_X.f`        (Codesys)
 *   literal  → text        (same in both backends, e.g. mode constants)
 */
export type SymbolStorage =
  | { kind: 'local'; name: string }
  | { kind: 'global'; name: string }
  | { kind: 'dbField'; dbName: string; fieldName: string }
  | { kind: 'literal'; text: string };

export interface ResolvedSymbol {
  pirName: string;
  kind: SymbolKind;
  valueType: ValueType;
  storage: SymbolStorage;
  stationId?: string;
  hint?: string;
}

const PIR_TO_VALUE: Record<string, ValueType> = {
  bool: 'bool',
  int: 'int',
  dint: 'int',
  real: 'real',
};

export function pirToValueType(pirDataType: string): ValueType {
  return PIR_TO_VALUE[pirDataType] ?? 'unknown';
}

const VALUE_TO_SCL: Record<ValueType, string> = {
  bool: 'BOOL',
  int: 'INT',
  real: 'REAL',
  string: 'STRING',
  unknown: 'VARIANT',
};

export function valueTypeToScl(v: ValueType): string {
  return VALUE_TO_SCL[v];
}

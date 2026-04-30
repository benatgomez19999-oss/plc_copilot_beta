import type { Equipment, EquipmentType, Station } from '@plccopilot/pir';

export const SIEMENS_DIR = 'siemens';

export const DB_PARAMS_NAME = 'DB_Global_Params';
export const DB_RECIPES_NAME = 'DB_Recipes';
export const DB_PARAMS_PATH = `${SIEMENS_DIR}/${DB_PARAMS_NAME}.scl`;
export const DB_RECIPES_PATH = `${SIEMENS_DIR}/${DB_RECIPES_NAME}.scl`;
export const TAGS_CSV_PATH = `${SIEMENS_DIR}/Tags_Main.csv`;
export const MANIFEST_PATH = `${SIEMENS_DIR}/manifest.json`;

export function toPascalCase(id: string): string {
  return id
    .split(/[_\-\s.]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1).toLowerCase())
    .join('');
}

export function stationName(station: Station): string {
  return toPascalCase(station.id);
}

export function stationFbName(station: Station): string {
  return `FB_${stationName(station)}`;
}

export function stationArtifactPath(station: Station): string {
  return `${SIEMENS_DIR}/${stationFbName(station)}.scl`;
}

export function equipmentName(eq: Equipment): string {
  const cs = eq.code_symbol?.trim();
  if (cs && cs.length > 0) return cs;
  return toPascalCase(eq.id);
}

export function sanitizeSymbol(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

const UDT_NAMES: Partial<Record<EquipmentType, string>> = {
  pneumatic_cylinder_2pos: 'UDT_Cylinder2Pos',
  motor_simple: 'UDT_MotorSimple',
  // Sprint 87C — Siemens accepts `valve_onoff` via the shared
  // codegen-core lowering. Public helper stays consistent with
  // `canonicalTypeName('valve_onoff') === 'UDT_ValveOnoff'`.
  valve_onoff: 'UDT_ValveOnoff',
};

export function udtName(type: EquipmentType): string | null {
  return UDT_NAMES[type] ?? null;
}

export function udtArtifactPath(type: EquipmentType): string | null {
  const n = udtName(type);
  return n ? `${SIEMENS_DIR}/${n}.scl` : null;
}

export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

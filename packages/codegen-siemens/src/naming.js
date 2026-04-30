export const SIEMENS_DIR = 'siemens';
export const DB_PARAMS_NAME = 'DB_Global_Params';
export const DB_RECIPES_NAME = 'DB_Recipes';
export const DB_PARAMS_PATH = `${SIEMENS_DIR}/${DB_PARAMS_NAME}.scl`;
export const DB_RECIPES_PATH = `${SIEMENS_DIR}/${DB_RECIPES_NAME}.scl`;
export const TAGS_CSV_PATH = `${SIEMENS_DIR}/Tags_Main.csv`;
export const MANIFEST_PATH = `${SIEMENS_DIR}/manifest.json`;
export function toPascalCase(id) {
    return id
        .split(/[_\-\s.]+/)
        .filter((s) => s.length > 0)
        .map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase())
        .join('');
}
export function stationName(station) {
    return toPascalCase(station.id);
}
export function stationFbName(station) {
    return `FB_${stationName(station)}`;
}
export function stationArtifactPath(station) {
    return `${SIEMENS_DIR}/${stationFbName(station)}.scl`;
}
export function equipmentName(eq) {
    const cs = eq.code_symbol?.trim();
    if (cs && cs.length > 0)
        return cs;
    return toPascalCase(eq.id);
}
export function sanitizeSymbol(raw) {
    return raw.replace(/[^A-Za-z0-9_]/g, '_');
}
const UDT_NAMES = {
    pneumatic_cylinder_2pos: 'UDT_Cylinder2Pos',
    motor_simple: 'UDT_MotorSimple',
    // Sprint 87C — Siemens accepts valve_onoff via shared lowering.
    valve_onoff: 'UDT_ValveOnoff',
    // Sprint 88I — Siemens accepts motor_vfd_simple after SCL audit.
    motor_vfd_simple: 'UDT_MotorVfdSimple',
};
export function udtName(type) {
    return UDT_NAMES[type] ?? null;
}
export function udtArtifactPath(type) {
    const n = udtName(type);
    return n ? `${SIEMENS_DIR}/${n}.scl` : null;
}
export function basename(path) {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(idx + 1) : path;
}

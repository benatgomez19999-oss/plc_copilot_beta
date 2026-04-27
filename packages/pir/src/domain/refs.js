// Centralised reference parsing + keyword/function registries.
// All rules touching PIR-Expr or activate[] entries must route through here.
export const EXPR_KEYWORDS = new Set([
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
]);
export const EXPR_FUNCTIONS = new Set([
    'timer_expired',
    'rising',
    'falling',
    'edge',
]);
export const ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]*$/;
export function isKeyword(token) {
    return EXPR_KEYWORDS.has(token);
}
export function isFunctionName(token) {
    return EXPR_FUNCTIONS.has(token);
}
export function isIdLike(token) {
    return ID_RE.test(token);
}
export function isEquipmentRoleFormat(s) {
    return /^[a-z][a-z0-9_]{1,62}\.[a-z_][a-z0-9_]*$/.test(s);
}
export function parseEquipmentRoleRef(ref) {
    const dot = ref.indexOf('.');
    if (dot < 0)
        return null;
    const equipment_id = ref.slice(0, dot);
    const role = ref.slice(dot + 1);
    if (!ID_RE.test(equipment_id))
        return null;
    if (!ROLE_RE.test(role))
        return null;
    if (role.includes('.'))
        return null; // only one level of qualification
    return { equipment_id, role };
}
export function parseActivationRef(ref) {
    const dot = ref.indexOf('.');
    if (dot < 0) {
        if (!ID_RE.test(ref))
            return null;
        return { equipment_id: ref, activity: null };
    }
    const equipment_id = ref.slice(0, dot);
    const activity = ref.slice(dot + 1);
    if (!ID_RE.test(equipment_id))
        return null;
    if (!ROLE_RE.test(activity))
        return null;
    if (activity.includes('.'))
        return null;
    return { equipment_id, activity };
}
export function resolveSymbol(input) {
    const { ref, ioIds, parameterIds, equipmentShapes } = input;
    if (EXPR_KEYWORDS.has(ref))
        return { kind: 'keyword' };
    if (ref.includes('.')) {
        const parsed = parseEquipmentRoleRef(ref);
        if (!parsed)
            return { kind: 'invalid_format' };
        const shape = equipmentShapes.get(parsed.equipment_id);
        if (!shape) {
            return { kind: 'unknown_equipment', equipment_id: parsed.equipment_id };
        }
        const known = shape.required_io.includes(parsed.role) ||
            shape.optional_io.includes(parsed.role);
        if (!known) {
            return {
                kind: 'unknown_role',
                equipment_id: parsed.equipment_id,
                role: parsed.role,
            };
        }
        return {
            kind: 'equipment_role',
            equipment_id: parsed.equipment_id,
            role: parsed.role,
        };
    }
    if (!ID_RE.test(ref))
        return { kind: 'invalid_format' };
    if (ioIds.has(ref))
        return { kind: 'io', id: ref };
    if (parameterIds.has(ref))
        return { kind: 'parameter', id: ref };
    return { kind: 'unknown' };
}

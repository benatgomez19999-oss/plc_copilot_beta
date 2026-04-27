// Centralised reference parsing + keyword/function registries.
// All rules touching PIR-Expr or activate[] entries must route through here.

export const EXPR_KEYWORDS: ReadonlySet<string> = new Set([
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

export const EXPR_FUNCTIONS: ReadonlySet<string> = new Set([
  'timer_expired',
  'rising',
  'falling',
  'edge',
]);

export const ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]*$/;

export function isKeyword(token: string): boolean {
  return EXPR_KEYWORDS.has(token);
}

export function isFunctionName(token: string): boolean {
  return EXPR_FUNCTIONS.has(token);
}

export function isIdLike(token: string): boolean {
  return ID_RE.test(token);
}

export interface EquipmentRoleRef {
  equipment_id: string;
  role: string;
}

export function isEquipmentRoleFormat(s: string): boolean {
  return /^[a-z][a-z0-9_]{1,62}\.[a-z_][a-z0-9_]*$/.test(s);
}

export function parseEquipmentRoleRef(ref: string): EquipmentRoleRef | null {
  const dot = ref.indexOf('.');
  if (dot < 0) return null;
  const equipment_id = ref.slice(0, dot);
  const role = ref.slice(dot + 1);
  if (!ID_RE.test(equipment_id)) return null;
  if (!ROLE_RE.test(role)) return null;
  if (role.includes('.')) return null; // only one level of qualification
  return { equipment_id, role };
}

/**
 * Parse an `activate[i]` entry.
 * Accepts either a bare equipment id or "equipment_id.activity_name".
 */
export type ActivationRef =
  | { equipment_id: string; activity: null }
  | { equipment_id: string; activity: string };

export function parseActivationRef(ref: string): ActivationRef | null {
  const dot = ref.indexOf('.');
  if (dot < 0) {
    if (!ID_RE.test(ref)) return null;
    return { equipment_id: ref, activity: null };
  }
  const equipment_id = ref.slice(0, dot);
  const activity = ref.slice(dot + 1);
  if (!ID_RE.test(equipment_id)) return null;
  if (!ROLE_RE.test(activity)) return null;
  if (activity.includes('.')) return null;
  return { equipment_id, activity };
}

// ---------- Symbol resolution (used by expression validator) ----------

export interface ShapeRoles {
  required_io: readonly string[];
  optional_io: readonly string[];
}

export interface SymbolResolveInput {
  ref: string;
  ioIds: ReadonlySet<string>;
  parameterIds: ReadonlySet<string>;
  equipmentShapes: ReadonlyMap<string, ShapeRoles>;
}

export type SymbolResolution =
  | { kind: 'keyword' }
  | { kind: 'io'; id: string }
  | { kind: 'parameter'; id: string }
  | { kind: 'equipment_role'; equipment_id: string; role: string }
  | { kind: 'unknown_equipment'; equipment_id: string }
  | { kind: 'unknown_role'; equipment_id: string; role: string }
  | { kind: 'invalid_format' }
  | { kind: 'unknown' };

export function resolveSymbol(input: SymbolResolveInput): SymbolResolution {
  const { ref, ioIds, parameterIds, equipmentShapes } = input;

  if (EXPR_KEYWORDS.has(ref)) return { kind: 'keyword' };

  if (ref.includes('.')) {
    const parsed = parseEquipmentRoleRef(ref);
    if (!parsed) return { kind: 'invalid_format' };
    const shape = equipmentShapes.get(parsed.equipment_id);
    if (!shape) {
      return { kind: 'unknown_equipment', equipment_id: parsed.equipment_id };
    }
    const known =
      shape.required_io.includes(parsed.role) ||
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

  if (!ID_RE.test(ref)) return { kind: 'invalid_format' };
  if (ioIds.has(ref)) return { kind: 'io', id: ref };
  if (parameterIds.has(ref)) return { kind: 'parameter', id: ref };
  return { kind: 'unknown' };
}

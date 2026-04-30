/**
 * Vendor-neutral fields per equipment type. The `dataType` strings are the
 * canonical IR spelling (`Bool`, `Int`, `DInt`, `Real`); each backend renderer
 * maps them to its own type name.
 *
 * Single source of truth: every backend consumes these — no parallel tables.
 */
const FIELDS = {
    pneumatic_cylinder_2pos: [
        { name: 'cmd_extend', dataType: 'Bool' },
        { name: 'fb_extended', dataType: 'Bool' },
        { name: 'fb_retracted', dataType: 'Bool' },
        { name: 'busy', dataType: 'Bool' },
        { name: 'fault', dataType: 'Bool' },
    ],
    motor_simple: [
        { name: 'run_cmd', dataType: 'Bool' },
        { name: 'running_fb', dataType: 'Bool' },
        { name: 'fault', dataType: 'Bool' },
    ],
    // Sprint 87A — minimal valve_onoff DUT shape.
    valve_onoff: [
        { name: 'cmd_open', dataType: 'Bool' },
        { name: 'fault', dataType: 'Bool' },
    ],
};
/**
 * Canonical IR type name per equipment type. The naming happens to match the
 * Siemens UDT convention (`UDT_*`) for historical reasons; backends may remap
 * at render time (Codesys: `DUT_*`). Keep stable — renderers depend on it.
 */
const CANONICAL_NAME = {
    pneumatic_cylinder_2pos: 'UDT_Cylinder2Pos',
    motor_simple: 'UDT_MotorSimple',
    // Sprint 87A — codesys renders this as `DUT_ValveOnoff`.
    valve_onoff: 'UDT_ValveOnoff',
};
/**
 * Resolve the canonical IR type name for a PIR equipment type. Returns
 * `null` for equipment types that have no canonical IR shape (e.g.,
 * `sensor_discrete` carries its data via the IO table, not a UDT).
 */
export function canonicalTypeName(eqType) {
    return CANONICAL_NAME[eqType] ?? null;
}
/**
 * @deprecated Use `canonicalTypeName`. The historical alias is kept for
 * backwards compatibility while consumers migrate to the new name.
 */
export const siemensTypeName = canonicalTypeName;
/**
 * Map the canonical IR type name (`UDT_*`) to the Codesys DUT counterpart.
 * Pure lexical: no central catalog, no PIR knowledge required.
 */
export function codesysTypeName(canonicalName) {
    return canonicalName.replace(/^UDT_/, 'DUT_');
}
/**
 * Build the project's vendor-neutral TypeArtifactIR list — one entry per
 * distinct `EquipmentType` actually used by any station. Sorted alphabetically
 * by canonical name for deterministic output.
 *
 * `path` carries the canonical logical name only — backends compute their own
 * filesystem paths at render time.
 */
export function buildEquipmentTypesIR(project) {
    const machine = project.machines[0];
    const typesUsed = new Set();
    for (const s of machine.stations) {
        for (const e of s.equipment)
            typesUsed.add(e.type);
    }
    const out = [];
    for (const t of typesUsed) {
        const name = CANONICAL_NAME[t];
        const fields = FIELDS[t];
        if (!name || !fields)
            continue;
        out.push({
            name,
            path: name,
            typeKind: 'equipment',
            fields: fields.slice(),
        });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

import { EQUIPMENT_SHAPES } from '../../domain/shapes/equipment.js';
import { parseActivationRef } from '../../domain/refs.js';
import { addIssue } from '../report.js';
/**
 * Resolve the expected direction + broad data-class for a given role on a
 * given equipment type. Pattern-based with a few explicit exceptions for
 * analog roles. Unknown → no expectation (skipped).
 */
function roleSpec(eqType, role) {
    // Explicit analog overrides
    if (eqType === 'motor_vfd_simple') {
        if (role === 'speed_setpoint_out')
            return { direction: 'out', dataClass: 'numeric' };
        if (role === 'speed_fb')
            return { direction: 'in', dataClass: 'numeric' };
    }
    if (eqType === 'sensor_analog' && role === 'signal_in') {
        return { direction: 'in', dataClass: 'numeric' };
    }
    // Pattern-based defaults
    if (role.endsWith('_out'))
        return { direction: 'out', dataClass: 'bool' };
    if (role.endsWith('_in'))
        return { direction: 'in', dataClass: 'bool' };
    if (role.startsWith('sensor_'))
        return { direction: 'in', dataClass: 'bool' };
    if (role.endsWith('_fb'))
        return { direction: 'in', dataClass: 'bool' };
    return {};
}
function dtypeCompatible(expected, actual) {
    if (expected === 'bool')
        return actual === 'bool';
    return actual !== 'bool';
}
export function runEquipmentRules(_project, ctx, report) {
    const base = `$.machines[0]`;
    // R-EQ-01..04 — per-equipment
    ctx.machine.stations.forEach((station, sIdx) => {
        station.equipment.forEach((eq, eIdx) => {
            const shape = EQUIPMENT_SHAPES[eq.type];
            const ep = `${base}.stations[${sIdx}].equipment[${eIdx}]`;
            // R-EQ-01 — required io roles present
            for (const role of shape.required_io) {
                if (!(role in eq.io_bindings)) {
                    addIssue(report, {
                        rule: 'R-EQ-01',
                        severity: 'error',
                        path: `${ep}.io_bindings`,
                        message: `equipment "${eq.id}" (${eq.type}) is missing required io role "${role}"`,
                    });
                }
            }
            // R-EQ-02 — bindings point to existing, compatible IO
            // R-EQ-03 — same io_id must not be bound to incompatible roles
            const ioToRoles = new Map();
            for (const [role, ioId] of Object.entries(eq.io_bindings)) {
                const rp = `${ep}.io_bindings.${role}`;
                // role name must be known for this equipment type
                const isKnownRole = shape.required_io.includes(role) || shape.optional_io.includes(role);
                if (!isKnownRole) {
                    addIssue(report, {
                        rule: 'R-EQ-02',
                        severity: 'error',
                        path: rp,
                        message: `role "${role}" is not defined for equipment type "${eq.type}"`,
                    });
                    continue;
                }
                const io = ctx.io_by_id.get(ioId);
                if (!io) {
                    addIssue(report, {
                        rule: 'R-EQ-02',
                        severity: 'error',
                        path: rp,
                        message: `io binding "${role}" points to unknown io "${ioId}"`,
                    });
                    continue;
                }
                const spec = roleSpec(eq.type, role);
                if (spec.direction && io.direction !== spec.direction) {
                    addIssue(report, {
                        rule: 'R-EQ-02',
                        severity: 'error',
                        path: rp,
                        message: `io "${ioId}" direction "${io.direction}" does not match role "${role}" (expects "${spec.direction}")`,
                    });
                }
                if (spec.dataClass && !dtypeCompatible(spec.dataClass, io.data_type)) {
                    addIssue(report, {
                        rule: 'R-EQ-02',
                        severity: 'error',
                        path: rp,
                        message: `io "${ioId}" dtype "${io.data_type}" is not compatible with role "${role}" (expects "${spec.dataClass}")`,
                    });
                }
                const arr = ioToRoles.get(ioId) ?? [];
                arr.push(role);
                ioToRoles.set(ioId, arr);
            }
            // R-EQ-03 — collapse per-io role groups, flag if directions or data classes diverge
            for (const [ioId, roles] of ioToRoles) {
                if (roles.length < 2)
                    continue;
                const specs = roles.map((r) => roleSpec(eq.type, r));
                const dirs = new Set(specs.map((s) => s.direction).filter((d) => !!d));
                const classes = new Set(specs
                    .map((s) => s.dataClass)
                    .filter((d) => !!d));
                if (dirs.size > 1 || classes.size > 1) {
                    addIssue(report, {
                        rule: 'R-EQ-03',
                        severity: 'error',
                        path: `${ep}.io_bindings`,
                        message: `io "${ioId}" is bound to incompatible roles [${roles.join(', ')}] on equipment "${eq.id}"`,
                    });
                }
            }
            // R-EQ-04 — required timing keys present
            const timing = eq.timing ?? {};
            for (const key of shape.required_timing) {
                if (!(key in timing)) {
                    addIssue(report, {
                        rule: 'R-EQ-04',
                        severity: 'error',
                        path: `${ep}.timing`,
                        message: `equipment "${eq.id}" is missing required timing key "${key}"`,
                    });
                }
            }
        });
    });
    // R-AV-01 — activity.activate entries must reference an existing equipment
    // with a non-empty allowed_activities set, and if qualified with ".activity"
    // that activity must be in the shape's allowed_activities.
    ctx.machine.stations.forEach((station, sIdx) => {
        station.sequence.states.forEach((st, stIdx) => {
            const activate = st.activity?.activate;
            if (!activate)
                return;
            activate.forEach((entry, aIdx) => {
                const path = `${base}.stations[${sIdx}].sequence.states[${stIdx}].activity.activate[${aIdx}]`;
                const parsed = parseActivationRef(entry);
                if (!parsed) {
                    addIssue(report, {
                        rule: 'R-AV-01',
                        severity: 'error',
                        path,
                        message: `activate entry "${entry}" has invalid format`,
                    });
                    return;
                }
                const target = ctx.equipment_by_id.get(parsed.equipment_id);
                if (!target) {
                    addIssue(report, {
                        rule: 'R-AV-01',
                        severity: 'error',
                        path,
                        message: `activate references unknown equipment "${parsed.equipment_id}"`,
                    });
                    return;
                }
                const targetShape = EQUIPMENT_SHAPES[target.type];
                if (parsed.activity === null) {
                    if (targetShape.allowed_activities.length === 0) {
                        addIssue(report, {
                            rule: 'R-AV-01',
                            severity: 'error',
                            path,
                            message: `equipment "${parsed.equipment_id}" (${target.type}) has no activatable activities`,
                        });
                    }
                    return;
                }
                if (!targetShape.allowed_activities.includes(parsed.activity)) {
                    addIssue(report, {
                        rule: 'R-AV-01',
                        severity: 'error',
                        path,
                        message: `activity "${parsed.activity}" is not allowed for equipment "${parsed.equipment_id}" (${target.type}); allowed: [${targetShape.allowed_activities.join(', ')}]`,
                    });
                }
            });
        });
    });
}

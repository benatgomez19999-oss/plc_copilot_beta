import { addIssue } from '../report.js';
export function matchesParameterType(param, value) {
    if (param.data_type === 'bool')
        return typeof value === 'boolean';
    if (typeof value !== 'number')
        return false;
    if (!Number.isFinite(value))
        return false;
    if (param.data_type === 'int' || param.data_type === 'dint') {
        return Number.isInteger(value);
    }
    return true; // 'real' accepts any finite number
}
export function isWithinRange(param, value) {
    if (typeof value !== 'number')
        return true;
    if (param.min !== undefined && value < param.min)
        return false;
    if (param.max !== undefined && value > param.max)
        return false;
    return true;
}
function renderRange(p) {
    return `[${p.min ?? '-inf'}, ${p.max ?? '+inf'}]`;
}
// Sprint 97 — Role-specific unit policy for `motor_vfd_simple.speed_setpoint_out`.
//
// The runtime semantics of `speed_setpoint_out` (motor frequency
// command) is "Hz" in v0. Operators occasionally express the same
// physical quantity as `rpm`, `%`, or vendor-specific aliases —
// none of which the codegen pipeline scales for them. R-PR-03
// rejects the cross-unit cases at validation time so the operator
// either restates the parameter in Hz or ships a custom mapping
// outside this v0 check.
//
// `null` from `normalizeSpeedSetpointUnit` means "unit string is
// not one of the supported Hz aliases"; an absent / empty unit is
// surfaced as a separate `PARAMETER_UNIT_MISSING_FOR_ROLE` info
// diagnostic rather than a hard error.
const SPEED_SETPOINT_HZ_ALIASES = new Set([
    'hz',
    'hertz',
]);
export function normalizeSpeedSetpointUnit(unit) {
    if (typeof unit !== 'string')
        return null;
    const trimmed = unit.trim();
    if (trimmed.length === 0)
        return null;
    if (SPEED_SETPOINT_HZ_ALIASES.has(trimmed.toLowerCase()))
        return 'Hz';
    return null;
}
export function runParameterRules(_project, ctx, report) {
    const base = `$.machines[0]`;
    // R-PR-02 — Parameter.default matches dtype + range
    ctx.machine.parameters.forEach((p, pIdx) => {
        const pp = `${base}.parameters[${pIdx}]`;
        if (!matchesParameterType(p, p.default)) {
            addIssue(report, {
                rule: 'R-PR-02',
                severity: 'error',
                path: `${pp}.default`,
                message: `default ${JSON.stringify(p.default)} does not match parameter "${p.id}" dtype "${p.data_type}"`,
            });
            return;
        }
        if (!isWithinRange(p, p.default)) {
            addIssue(report, {
                rule: 'R-PR-02',
                severity: 'error',
                path: `${pp}.default`,
                message: `default ${String(p.default)} for "${p.id}" is outside range ${renderRange(p)}`,
            });
        }
    });
    // R-PR-03 — Parameter range / unit consistency (Sprint 97).
    //
    // Two strands:
    //   (1) Defensive bound coherence. The Zod schema already
    //       rejects non-finite min/max and `min > max`, but PIRs
    //       constructed via `as Project` casts (e.g. fixtures, tests)
    //       can bypass Zod and reach the validator with malformed
    //       bounds. Reject them through the validator path too so a
    //       single rule string surfaces consistently.
    //   (2) Role-specific unit policy. For every parameter wired as
    //       a `motor_vfd_simple.speed_setpoint_out` setpoint, the
    //       unit must be a recognised Hz alias (or absent — missing
    //       unit is not a hard error in v0). Foreign units
    //       (`rpm`, `%`, `m/s`, …) hard-fail because Sprint 97 is
    //       explicitly non-converting.
    ctx.machine.parameters.forEach((p, pIdx) => {
        const pp = `${base}.parameters[${pIdx}]`;
        if (p.min !== undefined && !Number.isFinite(p.min)) {
            addIssue(report, {
                rule: 'R-PR-03',
                severity: 'error',
                path: `${pp}.min`,
                message: `parameter "${p.id}" min must be a finite number (got ${JSON.stringify(p.min)})`,
            });
        }
        if (p.max !== undefined && !Number.isFinite(p.max)) {
            addIssue(report, {
                rule: 'R-PR-03',
                severity: 'error',
                path: `${pp}.max`,
                message: `parameter "${p.id}" max must be a finite number (got ${JSON.stringify(p.max)})`,
            });
        }
        if (p.min !== undefined &&
            p.max !== undefined &&
            Number.isFinite(p.min) &&
            Number.isFinite(p.max) &&
            p.min > p.max) {
            addIssue(report, {
                rule: 'R-PR-03',
                severity: 'error',
                path: `${pp}`,
                message: `parameter "${p.id}" has min (${p.min}) greater than max (${p.max})`,
            });
        }
    });
    // R-PR-03 (B) — `speed_setpoint_out` parameters must be unit-Hz
    // (or unitless — missing unit is a soft signal handled at
    // ingestion / readiness time, not here). Walk the equipment
    // setpoint bindings to find the affected parameter ids.
    ctx.machine.stations.forEach((station) => {
        station.equipment.forEach((eq) => {
            if (eq.type !== 'motor_vfd_simple')
                return;
            const bindings = eq.io_setpoint_bindings ?? {};
            const paramId = bindings['speed_setpoint_out'];
            if (!paramId)
                return;
            const param = ctx.parameters_by_id.get(paramId);
            if (!param)
                return; // R-EQ-05 already flags missing parameter.
            if (param.unit === undefined || param.unit.trim().length === 0) {
                // Soft signal — Sprint 97 records this as info so
                // operator-grade fixtures keep passing. The PIR builder
                // adds a parallel `PIR_BUILD_PARAMETER_UNIT_MISSING_FOR_ROLE`
                // diagnostic at ingestion time.
                addIssue(report, {
                    rule: 'R-PR-03',
                    severity: 'info',
                    path: `$.machines[0].parameters[${ctx.machine.parameters.findIndex((q) => q.id === param.id)}].unit`,
                    message: `parameter "${param.id}" backs motor_vfd_simple.speed_setpoint_out but has no unit; Hz is expected.`,
                });
                return;
            }
            if (normalizeSpeedSetpointUnit(param.unit) === null) {
                addIssue(report, {
                    rule: 'R-PR-03',
                    severity: 'error',
                    path: `$.machines[0].parameters[${ctx.machine.parameters.findIndex((q) => q.id === param.id)}].unit`,
                    message: `parameter "${param.id}" backs motor_vfd_simple.speed_setpoint_out with unit ${JSON.stringify(param.unit)}; expected one of "Hz" / "hz" / "Hertz" / "HERTZ" (Sprint 97 does no scaling).`,
                });
            }
        });
    });
    // R-PR-01 — Recipe values reference existing Parameters; value dtype + range compatible
    ctx.machine.recipes.forEach((r, rIdx) => {
        for (const [key, value] of Object.entries(r.values)) {
            const path = `${base}.recipes[${rIdx}].values.${key}`;
            const p = ctx.parameters_by_id.get(key);
            if (!p) {
                addIssue(report, {
                    rule: 'R-PR-01',
                    severity: 'error',
                    path,
                    message: `recipe "${r.id}" references unknown parameter "${key}"`,
                });
                continue;
            }
            if (!matchesParameterType(p, value)) {
                addIssue(report, {
                    rule: 'R-PR-01',
                    severity: 'error',
                    path,
                    message: `value ${JSON.stringify(value)} does not match parameter "${key}" dtype "${p.data_type}"`,
                });
                continue;
            }
            if (!isWithinRange(p, value)) {
                addIssue(report, {
                    rule: 'R-PR-01',
                    severity: 'error',
                    path,
                    message: `value ${String(value)} is outside range ${renderRange(p)} for parameter "${key}"`,
                });
            }
        }
    });
}
//# sourceMappingURL=parameters.js.map
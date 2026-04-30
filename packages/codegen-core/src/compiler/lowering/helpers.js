import { parseActivationRef } from '@plccopilot/pir';
import { diag } from '../diagnostics.js';
import { interlockInhibitsPath, interlockWhenPath, stateActivityActivatePath, transitionFromPath, transitionTimeoutMsPath, } from '../diagnostic-paths.js';
/**
 * Sprint 41 — short, actionable hint for the most common interlock
 * authoring mistakes. Centralised so every emitter rendering this
 * code path attaches the same guidance text.
 */
const INTERLOCK_FIX_HINT = 'Use "equipmentId.activity" referencing an equipment in this station, and ensure the activity is supported.';
export const SUPPORTED_ACTIVITIES = {
    pneumatic_cylinder_2pos: ['extend', 'retract'],
    motor_simple: ['run', 'run_fwd'],
    sensor_discrete: [],
    // Sprint 87A — spring-return solenoid valve, single `open` activity.
    valve_onoff: ['open'],
};
export function commandVarName(eqId, activity) {
    return `${eqId}_${activity}_cmd`;
}
export function timerVarName(transitionId) {
    return `TON_${transitionId}`;
}
/** Returns `null` on success, or a typed Diagnostic if the activity is unsupported. */
export function checkActivitySupported(eq, activity, path, stationId) {
    const allowed = SUPPORTED_ACTIVITIES[eq.type];
    if (allowed === undefined) {
        // Sprint 41 — list the equipment types the lowering pipeline does
        // know how to wire so the integrator can either change the type
        // or extend `SUPPORTED_ACTIVITIES`.
        const supportedTypes = Object.keys(SUPPORTED_ACTIVITIES).join(', ');
        return diag('error', 'UNSUPPORTED_ACTIVITY', `Equipment type "${eq.type}" (equipment ${eq.id}) has no activity lowering strategy.`, {
            path,
            stationId,
            symbol: eq.id,
            hint: `Change ${eq.id}.type to one of (${supportedTypes}) or extend SUPPORTED_ACTIVITIES for "${eq.type}".`,
        });
    }
    if (!allowed.includes(activity)) {
        const allowedList = allowed.join(', ') || '(none)';
        return diag('error', 'UNSUPPORTED_ACTIVITY', `Activity "${activity}" is not supported on equipment type "${eq.type}" (allowed: ${allowedList}).`, {
            path,
            stationId,
            symbol: `${eq.id}.${activity}`,
            hint: `Use one of the allowed activities for type "${eq.type}" (${allowedList}), or extend SUPPORTED_ACTIVITIES.`,
        });
    }
    return null;
}
/**
 * Pure, diagnostic-first station scan. Always returns a best-effort plan:
 * items that produce error diagnostics are SKIPPED from the plan rather than
 * aborting the scan. Callers inspect `diagnostics` to decide whether to
 * proceed with codegen.
 *
 * Sprint 42 — when `pathContext` is supplied, every emitted diagnostic
 * carries a real `machines[i].stations[j]…` JSON path instead of the
 * FB-name placeholder. Back-compat callers omit the argument and keep
 * receiving the FB-name path (`fallbackPath`).
 */
export function scanStation(machine, station, stateIndex, path, pathContext) {
    const diagnostics = [];
    const commands = new Map();
    const timers = [];
    const interlocks = [];
    collectActivityCommands(station, path, diagnostics, commands, pathContext);
    collectTimers(station, stateIndex, path, diagnostics, timers, pathContext);
    collectStationInterlocks(machine, station, path, diagnostics, commands, interlocks, pathContext);
    return {
        plan: {
            timers,
            commands: Array.from(commands.values()),
            interlocks,
        },
        diagnostics,
    };
}
function collectActivityCommands(station, path, diagnostics, commands, pathContext) {
    station.sequence.states.forEach((s, stateIndex) => {
        if (!s.activity?.activate)
            return;
        s.activity.activate.forEach((ref, activateIndex) => {
            // Sprint 42 — when the caller supplied indices, build the
            // exact JSONPath of the offending activate entry. Otherwise
            // keep the FB-name placeholder (`path`) for back-compat.
            const activatePath = pathContext
                ? stateActivityActivatePath(pathContext.machineIndex, pathContext.stationIndex, stateIndex, activateIndex)
                : path;
            const parsed = parseActivationRef(ref);
            if (!parsed || !parsed.activity) {
                diagnostics.push(diag('error', 'INVALID_ACTIVATION', `Activation "${ref}" must be "equipmentId.activityName".`, {
                    path: activatePath,
                    stationId: station.id,
                    symbol: ref,
                    hint: 'Use the dotted form, e.g. "cyl01.extend", referencing an equipment in this station.',
                }));
                return;
            }
            const eq = station.equipment.find((e) => e.id === parsed.equipment_id);
            if (!eq) {
                diagnostics.push(diag('error', 'UNKNOWN_EQUIPMENT', `Activation "${ref}" refers to equipment "${parsed.equipment_id}" which is not in station "${station.id}".`, {
                    path: activatePath,
                    stationId: station.id,
                    symbol: parsed.equipment_id,
                    hint: 'Add the equipment to this station, or fix the activation to reference an equipment in this station.',
                }));
                return;
            }
            const actDiag = checkActivitySupported(eq, parsed.activity, activatePath, station.id);
            if (actDiag) {
                diagnostics.push(actDiag);
                return;
            }
            const key = `${parsed.equipment_id}.${parsed.activity}`;
            if (!commands.has(key)) {
                commands.set(key, {
                    equipmentId: parsed.equipment_id,
                    equipmentType: eq.type,
                    activity: parsed.activity,
                    varName: commandVarName(parsed.equipment_id, parsed.activity),
                    origin: 'activity',
                });
            }
        });
    });
}
function collectTimers(station, stateIndex, path, diagnostics, timers, pathContext) {
    station.sequence.transitions.forEach((t, transitionIndex) => {
        if (!t.timeout)
            return;
        const isWildcard = t.from === '*';
        const srcStateIdx = isWildcard ? -1 : (stateIndex.get(t.from) ?? -1);
        if (!isWildcard && srcStateIdx < 0) {
            // Sprint 42 — point at `transition.from` so the user can fix
            // the dangling source-state reference directly.
            const fromPath = pathContext
                ? transitionFromPath(pathContext.machineIndex, pathContext.stationIndex, transitionIndex)
                : path;
            diagnostics.push(diag('error', 'TIMEOUT_RENDER_ERROR', `Transition "${t.id}" has a timeout but references unknown source state "${t.from}".`, {
                path: fromPath,
                stationId: station.id,
                symbol: t.id,
                hint: 'Add the missing state to sequence.states, or change transition.from to an existing state id.',
            }));
            return;
        }
        if (t.timeout.ms <= 0) {
            // Sprint 42 — point at the offending `.timeout.ms` field.
            const msPath = pathContext
                ? transitionTimeoutMsPath(pathContext.machineIndex, pathContext.stationIndex, transitionIndex)
                : path;
            diagnostics.push(diag('error', 'TIMEOUT_RENDER_ERROR', `Transition "${t.id}" has a non-positive timeout (${t.timeout.ms} ms).`, {
                path: msPath,
                stationId: station.id,
                symbol: t.id,
                hint: 'Set timeout.ms to a positive integer (milliseconds) and timeout.alarm_id to an existing alarm id.',
            }));
            return;
        }
        timers.push({
            transitionId: t.id,
            srcStateIdx,
            isWildcard,
            ms: t.timeout.ms,
            alarmId: t.timeout.alarm_id,
            varName: timerVarName(t.id),
        });
    });
}
function collectStationInterlocks(machine, station, path, diagnostics, commands, interlocks, pathContext) {
    const stationEqIds = new Set(station.equipment.map((e) => e.id));
    // Sprint 41 — `ilIndex` lets us emit a real `machines[<m>]
    // .interlocks[i].inhibits` JSON path on every error, so the
    // web banner / CLI can jump straight to the offending entry.
    // Sprint 42 — `machineIndex` is now the real index from the
    // caller's loop instead of hardcoded 0; respects multi-machine
    // futures without changing today's single-machine behaviour.
    const machineIndex = pathContext?.machineIndex ?? 0;
    machine.interlocks.forEach((il, ilIndex) => {
        const inhibitsPath = interlockInhibitsPath(machineIndex, ilIndex);
        const parsed = parseActivationRef(il.inhibits);
        if (!parsed) {
            diagnostics.push(diag('error', 'INTERLOCK_ROLE_UNRESOLVED', `Interlock "${il.id}" has invalid inhibits "${il.inhibits}" — expected "equipmentId.activity".`, {
                path: inhibitsPath,
                stationId: station.id,
                symbol: il.id,
                hint: INTERLOCK_FIX_HINT,
            }));
            return;
        }
        if (!parsed.activity) {
            diagnostics.push(diag('error', 'INTERLOCK_ROLE_UNRESOLVED', `Interlock "${il.id}" inhibits "${il.inhibits}" must specify an activity.`, {
                path: inhibitsPath,
                stationId: station.id,
                symbol: il.id,
                hint: INTERLOCK_FIX_HINT,
            }));
            return;
        }
        if (!stationEqIds.has(parsed.equipment_id))
            return; // belongs to another station
        const eq = station.equipment.find((e) => e.id === parsed.equipment_id);
        const allowed = SUPPORTED_ACTIVITIES[eq.type];
        if (allowed === undefined || !allowed.includes(parsed.activity)) {
            const allowedList = (allowed ?? []).join(', ') || '(none)';
            diagnostics.push(diag('error', 'INTERLOCK_ROLE_UNRESOLVED', `Interlock "${il.id}" inhibits unsupported role "${parsed.activity}" on equipment "${parsed.equipment_id}" (type ${eq.type}; allowed: ${allowedList}).`, {
                path: inhibitsPath,
                stationId: station.id,
                symbol: `${parsed.equipment_id}.${parsed.activity}`,
                hint: `Use one of the allowed activities for type "${eq.type}" (${allowedList}), or change the interlock target.`,
            }));
            return;
        }
        const varName = commandVarName(parsed.equipment_id, parsed.activity);
        const key = `${parsed.equipment_id}.${parsed.activity}`;
        if (!commands.has(key)) {
            commands.set(key, {
                equipmentId: parsed.equipment_id,
                equipmentType: eq.type,
                activity: parsed.activity,
                varName,
                origin: 'interlock',
            });
        }
        // Sprint 43 — pre-compute the `il.when` expression context so
        // `lowerInterlocks` can decorate any expression-layer diagnostic
        // (parser / checker / IR builder) with the real
        // `machines[<m>].interlocks[<i>].when` JSON path. We have all the
        // indices in scope here; threading them downstream would be
        // wasteful when a frozen context object is enough.
        const whenContext = pathContext
            ? {
                path: interlockWhenPath(machineIndex, ilIndex),
                stationId: station.id,
                symbol: il.id,
                hint: 'Fix the interlock condition expression before generating artifacts.',
            }
            : undefined;
        interlocks.push({
            id: il.id,
            whenExpr: il.when,
            targetCmdVar: varName,
            equipmentId: parsed.equipment_id,
            activity: parsed.activity,
            ...(whenContext ? { whenContext } : {}),
        });
    });
}
export function commandsForEquipment(commands, eqId) {
    return commands.filter((c) => c.equipmentId === eqId);
}
/**
 * Back-compat shim kept in the module so any existing consumer that only
 * imported this symbol still type-checks. New code should call
 * `checkActivitySupported` instead.
 * @deprecated use {@link checkActivitySupported}.
 */
export function assertActivitySupported(eq, activity, path) {
    const d = checkActivitySupported(eq, activity, path, '');
    if (d) {
        // Keep throw for external callers that still rely on the old shape.
        const err = new Error(d.message);
        err.code = d.code;
        throw err;
    }
}

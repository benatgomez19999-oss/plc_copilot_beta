import { parseActivationRef } from '@plccopilot/pir';
import { diag } from '../diagnostics.js';
import { stateActivityActivatePath } from '../diagnostic-paths.js';
import { ir, ref } from '../ir/builder.js';
import { commandVarName } from './helpers.js';
/**
 * Sprint 42 — when callers thread a `LoweringPathContext` AND the
 * `stateIndex`, the diagnostics emitted here surface the exact
 * `…sequence.states[i].activity.activate[j]` path of the offending
 * activation entry.
 */
export function lowerStateActivity(state, station, diagnostics, pathContext, stateIndex) {
    const a = state.activity;
    if (!a)
        return [];
    const out = [];
    if (a.on_entry && a.on_entry.length > 0) {
        out.push(ir.comment(`on_entry: ${a.on_entry.length} action(s) — TODO: edge-driven lowering`));
    }
    if (a.activate) {
        a.activate.forEach((activationRef, activateIndex) => {
            const activatePath = pathContext && stateIndex !== undefined
                ? stateActivityActivatePath(pathContext.machineIndex, pathContext.stationIndex, stateIndex, activateIndex)
                : undefined;
            const parsed = parseActivationRef(activationRef);
            if (!parsed || !parsed.activity) {
                diagnostics.push(diag('error', 'INVALID_ACTIVATION', `Activation "${activationRef}" must be "equipmentId.activityName".`, {
                    ...(activatePath !== undefined ? { path: activatePath } : {}),
                    stationId: station.id,
                    symbol: activationRef,
                    hint: 'Use the dotted form, e.g. "cyl01.extend", referencing an equipment in this station.',
                }));
                return;
            }
            const eq = station.equipment.find((e) => e.id === parsed.equipment_id);
            if (!eq) {
                diagnostics.push(diag('error', 'UNKNOWN_EQUIPMENT', `Activation "${activationRef}" refers to equipment "${parsed.equipment_id}" which is not in station "${station.id}".`, {
                    ...(activatePath !== undefined ? { path: activatePath } : {}),
                    stationId: station.id,
                    symbol: parsed.equipment_id,
                    hint: 'Add the equipment to this station, or fix the activation to reference an equipment in this station.',
                }));
                return;
            }
            // Activity support already vetted by scanStation (helpers.ts).
            out.push(ir.comment(`activity.activate: ${activationRef}`));
            out.push(ir.assign(ref.local(commandVarName(parsed.equipment_id, parsed.activity)), ir.boolLit(true)));
        });
    }
    if (a.on_exit && a.on_exit.length > 0) {
        out.push(ir.comment(`on_exit: ${a.on_exit.length} action(s) — TODO: edge-driven lowering`));
    }
    return out;
}

import { diag } from '../diagnostics.js';
import { transitionGuardPath, transitionToPath, } from '../diagnostic-paths.js';
import { ir, lowerExpression, ref } from '../ir/builder.js';
import { lowerStateActivity } from './activities.js';
export function lowerSequence(station, stateIndex, _plan, table, edges, diagnostics, pathContext) {
    const arms = [];
    for (const s of station.sequence.states) {
        const idx = stateIndex.get(s.id);
        const body = [];
        // Sprint 42 — `idx` is the PIR position of `s` in
        // `sequence.states`, which is exactly the index the JSON path
        // needs (`…states[idx].activity.activate[k]`).
        body.push(...lowerStateActivity(s, station, diagnostics, pathContext, idx));
        // Sprint 42 — `transitionIndex` is taken from the **unsorted**
        // `station.sequence.transitions` array so the path matches the
        // PIR JSON layout. The lowering still iterates the priority-sorted
        // copy below to preserve generated order; we just resolve the
        // index against the original.
        const ts = station.sequence.transitions
            .map((t, transitionIndex) => ({ t, transitionIndex }))
            .filter(({ t }) => t.from === s.id)
            .slice()
            .sort((a, b) => b.t.priority - a.t.priority);
        for (const { t, transitionIndex } of ts) {
            body.push(...lowerTransition(t, transitionIndex, stateIndex, table, edges, diagnostics, pathContext));
        }
        arms.push({
            value: idx,
            label: `${s.id} (${s.kind})`,
            body,
        });
    }
    return ir.case_(ir.refExpr(ref.local('state')), arms);
}
export function lowerWildcardTransitions(station, stateIndex, table, edges, diagnostics, pathContext) {
    const wildcards = station.sequence.transitions
        .map((t, transitionIndex) => ({ t, transitionIndex }))
        .filter(({ t }) => t.from === '*')
        .slice()
        .sort((a, b) => b.t.priority - a.t.priority);
    if (wildcards.length === 0)
        return [];
    const out = [
        ir.comment('--- Wildcard (priority-ordered) transitions ---'),
    ];
    for (const { t, transitionIndex } of wildcards) {
        out.push(...lowerTransition(t, transitionIndex, stateIndex, table, edges, diagnostics, pathContext));
    }
    return out;
}
function lowerTransition(t, transitionIndex, stateIndex, table, edges, diagnostics, pathContext) {
    const toIdx = stateIndex.get(t.to);
    if (toIdx === undefined) {
        // Sprint 42 — point at `transition.to` so the user can fix the
        // dangling target reference directly.
        const toPath = pathContext
            ? transitionToPath(pathContext.machineIndex, pathContext.stationIndex, transitionIndex)
            : undefined;
        diagnostics.push(diag('error', 'UNKNOWN_STATE', `Transition "${t.id}" targets unknown state "${t.to}".`, {
            ...(toPath !== undefined ? { path: toPath } : {}),
            stationId: table.stationId,
            symbol: t.to,
            hint: 'Add the target state to sequence.states, or change transition.to to an existing state id.',
        }));
        return [];
    }
    // Sprint 43 — both `trigger` and `guard` lower as boolean
    // expressions; the trigger has no dedicated PIR field path
    // (it lives at `…transitions[i].trigger`) so we point at
    // `.guard` for the guard slot only. Diagnostics from inside the
    // expression layer (parser / checker / IR builder) inherit the
    // station + symbol + hint via the context.
    const guardContext = pathContext
        ? {
            path: transitionGuardPath(pathContext.machineIndex, pathContext.stationIndex, transitionIndex),
            stationId: table.stationId,
            symbol: t.id,
            hint: 'Fix the transition guard expression before generating artifacts.',
        }
        : undefined;
    const triggerContext = pathContext
        ? {
            // No dedicated PIR helper for `trigger` yet; carrying station
            // + symbol + hint is still better than nothing — `path`
            // intentionally omitted so we never fabricate a JSONPath.
            stationId: table.stationId,
            symbol: t.id,
            hint: 'Fix the transition trigger expression before generating artifacts.',
        }
        : undefined;
    const parts = [];
    if (t.trigger) {
        const { ir: triggerIr, diagnostics: triggerDiags } = lowerExpression(t.trigger, table, edges, triggerContext);
        diagnostics.push(...triggerDiags);
        parts.push(ir.paren(triggerIr));
    }
    if (t.guard) {
        const { ir: guardIr, diagnostics: guardDiags } = lowerExpression(t.guard, table, edges, guardContext);
        diagnostics.push(...guardDiags);
        parts.push(ir.paren(guardIr));
    }
    const cond = parts.length > 0 ? ir.andAll(parts) : ir.boolLit(true);
    const tag = `t=${t.id} prio=${t.priority}` +
        (t.timeout
            ? ` timeout=${t.timeout.ms}ms alarm=${t.timeout.alarm_id}`
            : '');
    return [
        ir.comment(tag),
        ir.if_(cond, [
            ir.assign(ref.local('state'), ir.numLit(toIdx, 'Int'), `-> ${t.to}`),
        ]),
    ];
}

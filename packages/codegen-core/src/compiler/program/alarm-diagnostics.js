import { alarmWhenPath } from '../diagnostic-paths.js';
import { lowerExpression } from '../ir/builder.js';
import { EdgeRegistry } from '../lowering/edges.js';
import { buildSymbolTable } from '../symbols/resolver.js';
/**
 * Sprint 44 — vendor-neutral, diagnostic-first validator for
 * `Alarm.when` expressions.
 *
 * `Alarm.when` is a PIR-level expression that today's compile pipeline
 * does NOT lower into any artifact (alarm setting is wired by station
 * FBs at fault transitions, not by an alarm-controller block). Without
 * this validator a typo in `alarm.when` would silently survive
 * generation; the user only finds out at runtime. We run the expression
 * through the existing parse + check + lower stack purely to harvest
 * diagnostics, then discard the IR. This keeps generated SCL/ST/CSV
 * byte-identical while plugging the metadata gap that Sprint 43 left
 * open.
 *
 * The decorated diagnostics carry:
 *   - `path:    machines[<m>].alarms[<i>].when`
 *   - `symbol:  alarm.id`
 *   - `hint:    "Fix the alarm condition expression before generating artifacts."`
 *
 * `stationId` is intentionally OMITTED because alarms are machine-level
 * — fabricating one from a "seed" station would be misleading.
 */
export function collectAlarmDiagnostics(machine, options = {}) {
    const out = [];
    if (machine.alarms.length === 0)
        return out;
    // The expression checker uses the SymbolTable to resolve refs
    // (IOs, parameters, equipment.role). The resolver requires a
    // station argument, but it iterates ALL stations to register
    // equipment.role symbols — picking the first station to seed it
    // gives us a machine-wide environment without changing resolver
    // semantics. If the machine has no stations at all, we skip
    // alarm validation rather than fabricate a synthetic station;
    // PIR-level rules cover that edge case anyway.
    const seedStation = machine.stations[0];
    if (!seedStation)
        return out;
    const { table } = buildSymbolTable(machine, seedStation);
    const machineIndex = options.machineIndex ?? 0;
    machine.alarms.forEach((al, alarmIndex) => {
        if (!al.when)
            return;
        const ctx = {
            path: alarmWhenPath(machineIndex, alarmIndex),
            symbol: al.id,
            hint: 'Fix the alarm condition expression before generating artifacts.',
        };
        // Fresh `EdgeRegistry` per alarm so any `rising(…)` / `falling(…)`
        // discovered here doesn't leak edge instances into station FBs.
        // Diagnostics from parse + check + lower stages all flow back
        // pre-decorated by `lowerExpression`'s sprint-43 hook.
        const { diagnostics } = lowerExpression(al.when, table, new EdgeRegistry(), ctx);
        out.push(...diagnostics);
    });
    return out;
}

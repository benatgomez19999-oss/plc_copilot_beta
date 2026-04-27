import { addIssue } from '../report.js';
export function runSafetyRules(_project, ctx, report) {
    const base = `$.machines[0]`;
    ctx.machine.safety_groups.forEach((g, gIdx) => {
        g.affects.forEach((ref, rIdx) => {
            const p = `${base}.safety_groups[${gIdx}].affects[${rIdx}]`;
            if (ref.kind === 'station') {
                if (!ctx.stations_by_id.has(ref.station_id)) {
                    addIssue(report, {
                        rule: 'R-SF-01',
                        severity: 'error',
                        path: `${p}.station_id`,
                        message: `unknown station "${ref.station_id}"`,
                    });
                }
            }
            else {
                if (!ctx.equipment_by_id.has(ref.equipment_id)) {
                    addIssue(report, {
                        rule: 'R-SF-01',
                        severity: 'error',
                        path: `${p}.equipment_id`,
                        message: `unknown equipment "${ref.equipment_id}"`,
                    });
                }
            }
        });
    });
}

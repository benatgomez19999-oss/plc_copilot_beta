import { addIssue } from '../report.js';
export function runSequenceRules(_project, ctx, report) {
    const base = `$.machines[0]`;
    ctx.machine.stations.forEach((station, sIdx) => {
        const sp = `${base}.stations[${sIdx}].sequence`;
        const states = station.sequence.states;
        const transitions = station.sequence.transitions;
        const stateIds = new Set(states.map((s) => s.id));
        const stateById = new Map(states.map((s) => [s.id, s]));
        const initials = states.filter((s) => s.kind === 'initial');
        if (initials.length !== 1) {
            addIssue(report, {
                rule: 'R-SM-01',
                severity: 'error',
                path: `${sp}.states`,
                message: `sequence must declare exactly one initial state, found ${initials.length}`,
            });
        }
        transitions.forEach((t, tIdx) => {
            const tp = `${sp}.transitions[${tIdx}]`;
            if (t.from !== '*' && !stateIds.has(t.from)) {
                addIssue(report, {
                    rule: 'R-SM-02',
                    severity: 'error',
                    path: `${tp}.from`,
                    message: `from state "${t.from}" does not exist`,
                });
            }
            if (!stateIds.has(t.to)) {
                addIssue(report, {
                    rule: 'R-SM-02',
                    severity: 'error',
                    path: `${tp}.to`,
                    message: `to state "${t.to}" does not exist`,
                });
            }
        });
        transitions.forEach((t, tIdx) => {
            if (t.timeout && !ctx.alarms_by_id.has(t.timeout.alarm_id)) {
                addIssue(report, {
                    rule: 'R-SM-05',
                    severity: 'error',
                    path: `${sp}.transitions[${tIdx}].timeout.alarm_id`,
                    message: `timeout.alarm_id "${t.timeout.alarm_id}" does not reference an existing alarm`,
                });
            }
        });
        const initial = initials[0];
        if (initial !== undefined) {
            const reachable = new Set([initial.id]);
            const queue = [initial.id];
            while (queue.length > 0) {
                const cur = queue.shift();
                for (const t of transitions) {
                    if (t.from === cur && stateIds.has(t.to) && !reachable.has(t.to)) {
                        reachable.add(t.to);
                        queue.push(t.to);
                    }
                }
            }
            states.forEach((st, stIdx) => {
                if (st.id === initial.id)
                    return;
                if (!reachable.has(st.id)) {
                    const reachedByWildcard = transitions.some((t) => t.from === '*' && t.to === st.id);
                    addIssue(report, {
                        rule: 'R-SM-03',
                        severity: reachedByWildcard ? 'warning' : 'error',
                        path: `${sp}.states[${stIdx}]`,
                        message: reachedByWildcard
                            ? `state "${st.id}" is only reachable via wildcard transitions`
                            : `state "${st.id}" is unreachable from the initial state`,
                    });
                }
            });
        }
        transitions.forEach((t, tIdx) => {
            if (t.from === '*') {
                const target = stateById.get(t.to);
                if (target && target.kind !== 'terminal') {
                    addIssue(report, {
                        rule: 'R-SM-07',
                        severity: 'info',
                        path: `${sp}.transitions[${tIdx}]`,
                        message: `wildcard transition targets non-terminal state "${t.to}"`,
                    });
                }
            }
        });
        const byFrom = new Map();
        for (const t of transitions) {
            const list = byFrom.get(t.from) ?? [];
            list.push(t);
            byFrom.set(t.from, list);
        }
        for (const [from, list] of byFrom) {
            const seen = new Map();
            for (const t of list) {
                const prev = seen.get(t.priority);
                if (prev !== undefined) {
                    const origIdx = transitions.indexOf(t);
                    addIssue(report, {
                        rule: 'R-SM-08',
                        severity: 'error',
                        path: `${sp}.transitions[${origIdx}].priority`,
                        message: `priority ${t.priority} collides with transition "${prev.id}" (both from "${from}")`,
                    });
                }
                else {
                    seen.set(t.priority, t);
                }
            }
        }
        const wildcards = byFrom.get('*') ?? [];
        if (wildcards.length > 0) {
            for (const [from, list] of byFrom) {
                if (from === '*')
                    continue;
                for (const concrete of list) {
                    for (const wc of wildcards) {
                        if (concrete.priority === wc.priority) {
                            const origIdx = transitions.indexOf(concrete);
                            addIssue(report, {
                                rule: 'R-SM-08',
                                severity: 'error',
                                path: `${sp}.transitions[${origIdx}].priority`,
                                message: `priority ${concrete.priority} overlaps with wildcard transition "${wc.id}"`,
                            });
                        }
                    }
                }
            }
        }
    });
}

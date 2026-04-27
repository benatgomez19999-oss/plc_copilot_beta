import { analyzeExpression } from '../../domain/expressions/lexer.js';
import { EXPR_FUNCTIONS, resolveSymbol, } from '../../domain/refs.js';
import { EQUIPMENT_SHAPES } from '../../domain/shapes/equipment.js';
import { addIssue } from '../report.js';
function collectExpressionSources(ctx) {
    const sources = [];
    const base = `$.machines[0]`;
    ctx.machine.stations.forEach((station, sIdx) => {
        station.sequence.transitions.forEach((t, tIdx) => {
            const tp = `${base}.stations[${sIdx}].sequence.transitions[${tIdx}]`;
            if (t.trigger)
                sources.push({ expr: t.trigger, path: `${tp}.trigger` });
            if (t.guard)
                sources.push({ expr: t.guard, path: `${tp}.guard` });
        });
    });
    ctx.machine.alarms.forEach((a, aIdx) => {
        if (a.when) {
            sources.push({ expr: a.when, path: `${base}.alarms[${aIdx}].when` });
        }
    });
    ctx.machine.interlocks.forEach((il, ilIdx) => {
        sources.push({
            expr: il.when,
            path: `${base}.interlocks[${ilIdx}].when`,
        });
    });
    ctx.machine.safety_groups.forEach((g, gIdx) => {
        sources.push({
            expr: g.trigger,
            path: `${base}.safety_groups[${gIdx}].trigger`,
        });
    });
    return sources;
}
export function runExpressionRules(_project, ctx, report) {
    const ioIds = new Set(ctx.machine.io.map((io) => io.id));
    const parameterIds = new Set(ctx.machine.parameters.map((p) => p.id));
    const equipmentShapes = new Map();
    for (const eq of ctx.equipment_by_id.values()) {
        const sh = EQUIPMENT_SHAPES[eq.type];
        equipmentShapes.set(eq.id, {
            required_io: sh.required_io,
            optional_io: sh.optional_io,
        });
    }
    for (const { expr, path } of collectExpressionSources(ctx)) {
        const analysis = analyzeExpression(expr);
        for (const issue of analysis.issues) {
            addIssue(report, {
                rule: 'R-EX-01',
                severity: 'error',
                path,
                message: `expression error: ${issue}`,
            });
        }
        for (const fc of analysis.functionCalls) {
            if (!EXPR_FUNCTIONS.has(fc.name)) {
                addIssue(report, {
                    rule: 'R-EX-01',
                    severity: 'error',
                    path,
                    message: `function "${fc.name}" is not in the v0.1 whitelist (${Array.from(EXPR_FUNCTIONS).join(', ')})`,
                });
            }
            else if (fc.args.length === 0) {
                addIssue(report, {
                    rule: 'R-EX-01',
                    severity: 'error',
                    path,
                    message: `function "${fc.name}" requires at least one argument`,
                });
            }
        }
        for (const ref of analysis.symbolRefs) {
            const res = resolveSymbol({ ref, ioIds, parameterIds, equipmentShapes });
            switch (res.kind) {
                case 'keyword':
                case 'io':
                case 'parameter':
                case 'equipment_role':
                    break;
                case 'unknown_equipment':
                    addIssue(report, {
                        rule: 'R-EX-01',
                        severity: 'error',
                        path,
                        message: `reference "${ref}" points to unknown equipment "${res.equipment_id}"`,
                    });
                    break;
                case 'unknown_role':
                    addIssue(report, {
                        rule: 'R-EX-01',
                        severity: 'error',
                        path,
                        message: `reference "${ref}": role "${res.role}" is not defined on equipment "${res.equipment_id}"`,
                    });
                    break;
                case 'invalid_format':
                    addIssue(report, {
                        rule: 'R-EX-01',
                        severity: 'error',
                        path,
                        message: `reference "${ref}" has invalid format`,
                    });
                    break;
                case 'unknown':
                    addIssue(report, {
                        rule: 'R-EX-01',
                        severity: 'error',
                        path,
                        message: `reference "${ref}" does not resolve to any io, parameter, equipment.role, or keyword`,
                    });
                    break;
            }
        }
    }
}

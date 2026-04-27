import { ir, lowerExpression, ref } from '../ir/builder.js';
export function lowerInterlocks(plan, table, edges, diagnostics) {
    if (plan.interlocks.length === 0)
        return [];
    const out = [
        ir.comment('--- Interlocks (functional inhibition, pre-output) ---'),
    ];
    for (const il of plan.interlocks) {
        out.push(ir.comment(`${il.id}: inhibits ${il.equipmentId}.${il.activity} when ${il.whenExpr}`));
        // Sprint 43 — pass the pre-stamped expression context so any
        // parser / checker / IR-builder diagnostic from `il.when`
        // surfaces with `machines[<m>].interlocks[<i>].when` as its
        // path. `whenContext` is undefined for callers that didn't
        // supply a `LoweringPathContext` to scanStation; lowerExpression
        // treats that as a no-op.
        const { ir: condIr, diagnostics: whenDiags } = lowerExpression(il.whenExpr, table, edges, il.whenContext);
        diagnostics.push(...whenDiags);
        out.push(ir.if_(ir.paren(condIr), [
            ir.assign(ref.local(il.targetCmdVar), ir.boolLit(false)),
        ]));
    }
    return out;
}

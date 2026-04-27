import type { Station } from '@plccopilot/pir';
import { diag, type Diagnostic } from '../diagnostics.js';
import { transitionTimeoutPath } from '../diagnostic-paths.js';
import { ir, ref } from '../ir/builder.js';
import type { ExprIR, RefIR, StmtIR, VarDeclIR } from '../ir/nodes.js';
import { storageToRef } from '../symbols/render-symbol.js';
import type { SymbolTable } from '../symbols/table.js';
import type { LoweringPathContext } from './context.js';
import type { StationPlan } from './helpers.js';

export function buildTimerVarDecls(plan: StationPlan): VarDeclIR[] {
  const decls: VarDeclIR[] = [];
  plan.timers.forEach((t, idx) => {
    decls.push({
      name: t.varName,
      type: 'TON',
      comment: `alarm: ${t.alarmId} (${t.ms} ms${t.isWildcard ? ', wildcard' : ''})`,
      preComment: idx === 0 ? '--- Transition timeouts (TON) ---' : undefined,
    });
  });
  return decls;
}

export function lowerTimerBlock(
  plan: StationPlan,
  table: SymbolTable,
  diagnostics: Diagnostic[] = [],
  stationId?: string,
  path?: string,
  pathContext?: LoweringPathContext,
  station?: Station,
): StmtIR[] {
  if (plan.timers.length === 0) return [];

  for (const t of plan.timers) {
    // Sprint 42 — when caller supplies indices AND we can locate the
    // transition in the live station object, point the info diagnostic
    // at `…sequence.transitions[i].timeout`. Falls back to the
    // FB-name placeholder when context is absent.
    let timeoutPath: string | undefined = path;
    if (pathContext && station) {
      const ti = station.sequence.transitions.findIndex(
        (tr) => tr.id === t.transitionId,
      );
      if (ti >= 0) {
        timeoutPath = transitionTimeoutPath(
          pathContext.machineIndex,
          pathContext.stationIndex,
          ti,
        );
      }
    }
    diagnostics.push(
      diag(
        'info',
        'TIMEOUT_NO_AUTO_TRANSITION',
        `Transition "${t.transitionId}" timeout (${t.ms} ms) raises alarm "${t.alarmId}" but does not auto-transition to a fault state.`,
        {
          path: timeoutPath,
          stationId,
          symbol: t.transitionId,
          hint: 'The timeout raises the alarm only. Add an explicit transition with this timeout if the sequence should move to a fault state.',
        },
      ),
    );
  }

  const out: StmtIR[] = [
    ir.comment(
      '--- Transition timeouts (tick while in source state; raise alarm on expiry) ---',
    ),
  ];

  for (const t of plan.timers) {
    const inExpr: ExprIR = t.isWildcard
      ? ir.boolLit(true)
      : ir.paren(
          ir.bin(
            '=',
            ir.refExpr(ref.local('state')),
            ir.numLit(t.srcStateIdx, 'Int'),
          ),
        );

    out.push(ir.ton(ref.fbInstance(t.varName), inExpr, t.ms));

    const alarmSym = table.resolve(t.alarmId);
    const alarmTarget: RefIR = alarmSym
      ? storageToRef(alarmSym.storage)
      : ref.global(t.alarmId);

    // TON.Q check is now backend-neutral: InstanceField composes renderRef
    // (#TON_x for Siemens, TON_x for Codesys) with the .Q field.
    out.push(
      ir.if_(
        ir.instanceField(ref.fbInstance(t.varName), 'Q'),
        [
          ir.assign(
            alarmTarget,
            ir.boolLit(true),
            `alarm from transition "${t.transitionId}"`,
          ),
        ],
      ),
    );
  }
  return out;
}

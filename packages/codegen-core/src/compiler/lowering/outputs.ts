import type { Equipment, Station } from '@plccopilot/pir';
import { diag, type Diagnostic } from '../diagnostics.js';
import {
  equipmentIoBindingPath,
  equipmentTypePath,
} from '../diagnostic-paths.js';
import { ir, ref } from '../ir/builder.js';
import type { ExprIR, StmtIR } from '../ir/nodes.js';
import { storageToRef } from '../symbols/render-symbol.js';
import type { SymbolTable } from '../symbols/table.js';
import type { LoweringPathContext } from './context.js';
import {
  commandsForEquipment,
  commandVarName,
  type CommandPlan,
  type StationPlan,
} from './helpers.js';

interface WireMeta {
  pathContext?: LoweringPathContext;
  equipmentIndex: number;
}

export function lowerOutputWiring(
  station: Station,
  plan: StationPlan,
  table: SymbolTable,
  diagnostics: Diagnostic[],
  pathContext?: LoweringPathContext,
): StmtIR[] {
  const out: StmtIR[] = [];
  let headerEmitted = false;

  station.equipment.forEach((eq, equipmentIndex) => {
    const cmds = commandsForEquipment(plan.commands, eq.id);
    if (cmds.length === 0) return;
    if (!headerEmitted) {
      out.push(ir.comment('--- Output wiring: commands -> physical IO ---'));
      headerEmitted = true;
    }
    out.push(
      ...wireEquipment(eq, cmds, table, diagnostics, {
        pathContext,
        equipmentIndex,
      }),
    );
  });
  return out;
}

function wireEquipment(
  eq: Equipment,
  cmds: readonly CommandPlan[],
  table: SymbolTable,
  diagnostics: Diagnostic[],
  meta: WireMeta,
): StmtIR[] {
  switch (eq.type) {
    case 'pneumatic_cylinder_2pos':
      return wireCylinder2Pos(eq, cmds, table, diagnostics, meta);
    case 'motor_simple':
      return wireMotorSimple(eq, cmds, table, diagnostics, meta);
    case 'sensor_discrete':
      return [];
    // Sprint 87A — spring-return on/off valve. Single `open` activity
    // drives a single `solenoid_out` coil; when the activity is not
    // active, the spring closes the valve. No close output is wired.
    case 'valve_onoff':
      return wireValveOnoff(eq, cmds, table, diagnostics, meta);
    default: {
      // Sprint 41 — surface the equipment id and a hint listing the
      // wiring strategies the lowering layer knows.
      // Sprint 42 — point at `equipment[i].type` JSON path when
      // available so the user can fix the offending field directly.
      const typePath = meta.pathContext
        ? equipmentTypePath(
            meta.pathContext.machineIndex,
            meta.pathContext.stationIndex,
            meta.equipmentIndex,
          )
        : undefined;
      diagnostics.push(
        diag(
          'error',
          'UNSUPPORTED_ACTIVITY',
          `Equipment "${eq.id}" (type ${eq.type}) has no output-wiring strategy.`,
          {
            ...(typePath !== undefined ? { path: typePath } : {}),
            stationId: table.stationId,
            symbol: eq.id,
            hint: `Change ${eq.id}.type to one of (pneumatic_cylinder_2pos, motor_simple, sensor_discrete, valve_onoff) or extend wireEquipment for "${eq.type}".`,
          },
        ),
      );
      return [];
    }
  }
}

function wireCylinder2Pos(
  eq: Equipment,
  cmds: readonly CommandPlan[],
  table: SymbolTable,
  diagnostics: Diagnostic[],
  meta: WireMeta,
): StmtIR[] {
  const hasExtend = cmds.some((c) => c.activity === 'extend');
  const hasRetract = cmds.some((c) => c.activity === 'retract');
  const solSym = table.resolve(`${eq.id}.solenoid_out`);
  if (!solSym) {
    // Sprint 42 — `equipment[i].io_bindings.solenoid_out` JSON path
    // so the user lands on the exact missing binding.
    const bindingPath = meta.pathContext
      ? equipmentIoBindingPath(
          meta.pathContext.machineIndex,
          meta.pathContext.stationIndex,
          meta.equipmentIndex,
          'solenoid_out',
        )
      : undefined;
    diagnostics.push(
      diag(
        'error',
        'UNBOUND_ROLE',
        `Equipment "${eq.id}" has no solenoid_out binding.`,
        {
          ...(bindingPath !== undefined ? { path: bindingPath } : {}),
          stationId: table.stationId,
          symbol: `${eq.id}.solenoid_out`,
          hint: `Bind "solenoid_out" in equipment "${eq.id}".io_bindings to an IO of type bool.`,
        },
      ),
    );
    return [];
  }
  const solRef = storageToRef(solSym.storage);
  const extendExpr = ir.refExpr(ref.local(commandVarName(eq.id, 'extend')));
  const retractExpr = ir.refExpr(ref.local(commandVarName(eq.id, 'retract')));

  if (hasExtend && hasRetract) {
    return [
      ir.comment(
        `${eq.id} (pneumatic_cylinder_2pos): mutually-exclusive extend/retract -> solenoid_out`,
      ),
      ir.assign(solRef, ir.bin('AND', extendExpr, ir.not(retractExpr))),
    ];
  }
  if (hasExtend) {
    return [
      ir.comment(
        `${eq.id} (pneumatic_cylinder_2pos): extend -> solenoid_out`,
      ),
      ir.assign(solRef, extendExpr),
    ];
  }
  if (hasRetract) {
    return [
      ir.comment(
        `${eq.id} (pneumatic_cylinder_2pos): retract -> NOT solenoid_out`,
      ),
      ir.assign(solRef, ir.not(retractExpr)),
    ];
  }
  return [];
}

function wireMotorSimple(
  eq: Equipment,
  cmds: readonly CommandPlan[],
  table: SymbolTable,
  diagnostics: Diagnostic[],
  meta: WireMeta,
): StmtIR[] {
  const runCmd = cmds.find((c) => c.activity === 'run');
  const runFwdCmd = cmds.find((c) => c.activity === 'run_fwd');
  const runSym = table.resolve(`${eq.id}.run_out`);
  if (!runSym) {
    // Sprint 42 — `equipment[i].io_bindings.run_out` JSON path.
    const bindingPath = meta.pathContext
      ? equipmentIoBindingPath(
          meta.pathContext.machineIndex,
          meta.pathContext.stationIndex,
          meta.equipmentIndex,
          'run_out',
        )
      : undefined;
    diagnostics.push(
      diag(
        'error',
        'UNBOUND_ROLE',
        `Equipment "${eq.id}" has no run_out binding.`,
        {
          ...(bindingPath !== undefined ? { path: bindingPath } : {}),
          stationId: table.stationId,
          symbol: `${eq.id}.run_out`,
          hint: `Bind "run_out" in equipment "${eq.id}".io_bindings to an IO of type bool.`,
        },
      ),
    );
    return [];
  }

  const parts: ExprIR[] = [];
  if (runCmd) parts.push(ir.refExpr(ref.local(runCmd.varName)));
  if (runFwdCmd) parts.push(ir.refExpr(ref.local(runFwdCmd.varName)));
  if (parts.length === 0) return [];

  return [
    ir.comment(`${eq.id} (motor_simple): run_cmd | run_fwd_cmd -> run_out`),
    ir.assign(storageToRef(runSym.storage), ir.orAll(parts)),
  ];
}

// Sprint 87A — single-coil spring-return solenoid valve.
//
// Wiring contract (intentionally minimal):
//   - one role binding: `solenoid_out` (BOOL output).
//   - one activity: `open` (the sequence sets it while the valve
//     should be energised; releasing it lets the spring close the
//     valve).
//   - no feedback wiring, no fault latching, no close output.
//     Real-process safeties (close-on-stop, position feedback,
//     manual override) are deliberately NOT synthesised — they
//     belong in a higher-fidelity equipment kind, not in v0.
function wireValveOnoff(
  eq: Equipment,
  cmds: readonly CommandPlan[],
  table: SymbolTable,
  diagnostics: Diagnostic[],
  meta: WireMeta,
): StmtIR[] {
  const openCmd = cmds.find((c) => c.activity === 'open');
  const solSym = table.resolve(`${eq.id}.solenoid_out`);
  if (!solSym) {
    const bindingPath = meta.pathContext
      ? equipmentIoBindingPath(
          meta.pathContext.machineIndex,
          meta.pathContext.stationIndex,
          meta.equipmentIndex,
          'solenoid_out',
        )
      : undefined;
    diagnostics.push(
      diag(
        'error',
        'UNBOUND_ROLE',
        `Equipment "${eq.id}" has no solenoid_out binding.`,
        {
          ...(bindingPath !== undefined ? { path: bindingPath } : {}),
          stationId: table.stationId,
          symbol: `${eq.id}.solenoid_out`,
          hint: `Bind "solenoid_out" in equipment "${eq.id}".io_bindings to an IO of type bool.`,
        },
      ),
    );
    return [];
  }
  if (!openCmd) {
    // No `open` activity drives this valve — emit nothing (the
    // command would always be FALSE, which is the spring-return
    // resting state). The `solenoid_out` IO retains whatever the
    // station-FB initialiser sets it to.
    return [];
  }
  return [
    ir.comment(`${eq.id} (valve_onoff): open_cmd -> solenoid_out`),
    ir.assign(
      storageToRef(solSym.storage),
      ir.refExpr(ref.local(openCmd.varName)),
    ),
  ];
}

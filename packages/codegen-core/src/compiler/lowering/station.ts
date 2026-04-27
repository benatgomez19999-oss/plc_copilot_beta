import type { Machine, State, Station } from '@plccopilot/pir';
import {
  stationFbName,
  stationName,
} from '../../naming.js';
import {
  scanStation,
  type StationPlan,
} from './helpers.js';
import {
  diag,
  hasErrors,
  type Diagnostic,
} from '../diagnostics.js';
import { statesPath } from '../diagnostic-paths.js';
import type { LoweringPathContext } from './context.js';
import { ir, ref } from '../ir/builder.js';
import type {
  FunctionBlockIR,
  StmtIR,
  VarDeclIR,
  VarSectionIR,
} from '../ir/nodes.js';
import {
  buildSymbolTable,
  registerLocalCommand,
} from '../symbols/resolver.js';
import type { SymbolTable } from '../symbols/table.js';
import {
  buildEdgeVarDecls,
  EdgeRegistry,
  lowerEdgeTickBlock,
} from './edges.js';
import { buildTimerVarDecls, lowerTimerBlock } from './timers.js';
import { lowerInterlocks } from './interlocks.js';
import { lowerOutputWiring } from './outputs.js';
import { lowerSequence, lowerWildcardTransitions } from './sequence.js';

export interface StationLoweringResult {
  fb: FunctionBlockIR;
  diagnostics: Diagnostic[];
}

export interface LowerStationOptions {
  /**
   * When true, alarm symbols resolve to `"DB_Alarms".set_<id>` (v2 alarm
   * contract). When false, they resolve to loose `"<id>"` tags. Defaults to
   * `machine.alarms.length > 0` so standalone calls stay consistent with the
   * project-level compiler.
   */
  useDbAlarms?: boolean;
  /**
   * Sprint 42 — optional PIR coordinates so emitted diagnostics carry
   * real `machines[i].stations[j]…` JSON paths instead of the FB-name
   * placeholder. `compileProject` populates this from its loop;
   * standalone callers (tests, the `generateStationFb` façade) can omit
   * it and accept the legacy FB-name fallback.
   */
  pathContext?: LoweringPathContext;
}

export function lowerStation(
  machine: Machine,
  station: Station,
  options: LowerStationOptions = {},
): StationLoweringResult {
  // Logical artifact label for diagnostics; backends compute their own
  // filesystem paths at render time.
  const path = stationFbName(station);
  const diagnostics: Diagnostic[] = [];
  // Sprint 42 — when the caller doesn't supply a `pathContext`, try to
  // recover the station's index from the live machine. Falls back to
  // `undefined` (FB-name placeholder) when the station isn't part of
  // `machine.stations` (e.g. detached test fixtures).
  const inferredStationIndex = machine.stations.indexOf(station);
  const pathContext: LoweringPathContext | undefined =
    options.pathContext ??
    (inferredStationIndex >= 0
      ? { machineIndex: 0, stationIndex: inferredStationIndex }
      : undefined);

  // --- Pass 0: structural validation ---
  diagnostics.push(...validateStation(station, path, pathContext));
  if (hasErrors(diagnostics)) {
    return { fb: emptyFb(station), diagnostics };
  }

  // --- Pass 1: symbol table ---
  const { table, diagnostics: symDiags } = buildSymbolTable(machine, station, {
    useDbAlarms: options.useDbAlarms,
  });
  diagnostics.push(...symDiags);

  const stateIndex = indexStates(station.sequence.states);

  // --- Pass 1b: plan scan (commands / timers / station-scoped interlocks) ---
  const scanResult = scanStation(
    machine,
    station,
    stateIndex,
    path,
    pathContext,
  );
  diagnostics.push(...scanResult.diagnostics);
  if (!scanResult.plan || hasErrors(diagnostics)) {
    return { fb: emptyFb(station), diagnostics };
  }
  const plan = scanResult.plan;

  // Register station-local command symbols for the renderer.
  for (const cmd of plan.commands) registerLocalCommand(table, cmd.varName);

  // --- Edge registry: namespaced by stationId to avoid cross-station collisions ---
  const edges = new EdgeRegistry(station.id);

  // --- Pass 2-6: lowering ---
  const caseStmt = lowerSequence(
    station,
    stateIndex,
    plan,
    table,
    edges,
    diagnostics,
    pathContext,
  );
  const wildcardStmts = lowerWildcardTransitions(
    station,
    stateIndex,
    table,
    edges,
    diagnostics,
    pathContext,
  );
  const timerStmts = lowerTimerBlock(
    plan,
    table,
    diagnostics,
    station.id,
    path,
    pathContext,
    station,
  );
  const interlockStmts = lowerInterlocks(plan, table, edges, diagnostics);
  const wiringStmts = lowerOutputWiring(
    station,
    plan,
    table,
    diagnostics,
    pathContext,
  );

  // Harvest any edge-collision diagnostics collected while lowering.
  diagnostics.push(...edges.collectedDiagnostics());

  // --- Pass 7: assemble ---
  const initialIdx = findInitialIndex(station.sequence.states);
  const body = assembleBody({
    resetStmts: lowerResetBlock(plan),
    edgeStmts: lowerEdgeTickBlock(edges),
    wildcardStmts,
    caseStmt,
    timerStmts,
    interlockStmts,
    wiringStmts,
  });

  const fb: FunctionBlockIR = {
    name: stationFbName(station),
    stationId: station.id,
    headerComments: buildHeaderComments(station),
    // Backend-specific attributes (Siemens TIA optimised access, etc.) are
    // injected by each backend renderer — core stays vendor-neutral.
    attributes: [],
    version: '0.1',
    varSections: buildVarSections(plan, edges, initialIdx),
    body,
  };

  return { fb, diagnostics };
}

// -------------------- helpers --------------------

function validateStation(
  station: Station,
  path: string,
  pathContext?: LoweringPathContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Sprint 42 — when the indices are known, every structural error
  // points at `machines[i].stations[j].sequence.states` so the
  // reader can jump directly to the offending array.
  const seqStatesPath = pathContext
    ? statesPath(pathContext.machineIndex, pathContext.stationIndex)
    : path;
  if (station.sequence.states.length === 0) {
    out.push(
      diag(
        'error',
        'EMPTY_STATION',
        `Station "${station.id}" has no states.`,
        {
          path: seqStatesPath,
          stationId: station.id,
          symbol: station.id,
          hint: 'Add at least one state to station.sequence.states and mark exactly one as kind="initial".',
        },
      ),
    );
    return out;
  }
  const initials = station.sequence.states.filter((s) => s.kind === 'initial');
  if (initials.length === 0) {
    out.push(
      diag(
        'error',
        'NO_INITIAL_STATE',
        `Station "${station.id}" has no initial state.`,
        {
          path: seqStatesPath,
          stationId: station.id,
          symbol: station.id,
          hint: 'Mark exactly one state in sequence.states as kind="initial".',
        },
      ),
    );
  } else if (initials.length > 1) {
    out.push(
      diag(
        'error',
        'MULTIPLE_INITIAL_STATES',
        `Station "${station.id}" has ${initials.length} initial states; exactly one is required.`,
        {
          path: seqStatesPath,
          stationId: station.id,
          symbol: station.id,
          hint: 'Demote all but one of the initial states (set kind to "step", "fault" or another non-initial kind).',
        },
      ),
    );
  }
  return out;
}

function indexStates(states: readonly State[]): Map<string, number> {
  const m = new Map<string, number>();
  states.forEach((s, i) => m.set(s.id, i));
  return m;
}

function findInitialIndex(states: readonly State[]): number {
  return states.findIndex((s) => s.kind === 'initial');
}

function lowerResetBlock(plan: StationPlan): StmtIR[] {
  if (plan.commands.length === 0) return [];
  const out: StmtIR[] = [
    ir.comment('--- Cycle-reset of command outputs ---'),
  ];
  for (const c of plan.commands) {
    out.push(ir.assign(ref.local(c.varName), ir.boolLit(false)));
  }
  return out;
}

function assembleBody(parts: {
  resetStmts: StmtIR[];
  edgeStmts: StmtIR[];
  wildcardStmts: StmtIR[];
  caseStmt: StmtIR;
  timerStmts: StmtIR[];
  interlockStmts: StmtIR[];
  wiringStmts: StmtIR[];
}): StmtIR[] {
  const body: StmtIR[] = [];

  if (parts.resetStmts.length > 0) {
    body.push(...parts.resetStmts, ir.blankLine());
  }
  if (parts.edgeStmts.length > 0) {
    body.push(...parts.edgeStmts, ir.blankLine());
  }
  if (parts.wildcardStmts.length > 0) {
    body.push(...parts.wildcardStmts, ir.blankLine());
  }

  body.push(ir.comment('--- Sequence dispatch ---'));
  body.push(parts.caseStmt);
  body.push(ir.blankLine());

  if (parts.timerStmts.length > 0) {
    body.push(...parts.timerStmts, ir.blankLine());
  }
  if (parts.interlockStmts.length > 0) {
    body.push(...parts.interlockStmts, ir.blankLine());
  }
  if (parts.wiringStmts.length > 0) {
    body.push(...parts.wiringStmts, ir.blankLine());
  }

  body.push(
    ir.assign(ref.local('o_state'), ir.refExpr(ref.local('state'))),
  );
  body.push(ir.blankLine());
  return body;
}

function buildVarSections(
  plan: StationPlan,
  edges: EdgeRegistry,
  initialIdx: number,
): VarSectionIR[] {
  const inputs: VarDeclIR[] = [
    {
      name: 'i_mode',
      type: 'INT',
      comment: '1=auto 2=manual 3=setup 4=maintenance',
    },
    { name: 'i_start_cmd', type: 'BOOL' },
    { name: 'i_release_cmd', type: 'BOOL' },
    { name: 'i_estop_active', type: 'BOOL' },
  ];

  const outputs: VarDeclIR[] = [
    { name: 'o_state', type: 'INT' },
    ...plan.commands.map((c) => ({
      name: c.varName,
      type: 'BOOL',
      comment: `${c.equipmentId} -> ${c.activity}`,
    })),
  ];

  const varDecls: VarDeclIR[] = [
    { name: 'state', type: 'INT', init: String(initialIdx) },
    ...buildTimerVarDecls(plan),
    ...buildEdgeVarDecls(edges),
  ];

  return [
    { section: 'VAR_INPUT', decls: inputs },
    { section: 'VAR_OUTPUT', decls: outputs },
    { section: 'VAR', decls: varDecls },
  ];
}

function buildHeaderComments(station: Station): string[] {
  // Markers (// or (* *)) are intentionally absent — each backend renderer
  // wraps these lines with its own comment syntax.
  return [
    `==================================================================`,
    `${stationName(station)} — state machine`,
    `Generated by @plccopilot/codegen-core v0.1.0`,
    `Station id: ${station.id}`,
    `==================================================================`,
  ];
}

function emptyFb(station: Station): FunctionBlockIR {
  return {
    name: stationFbName(station),
    stationId: station.id,
    headerComments: buildHeaderComments(station),
    // Backend attributes injected by each renderer — see station.ts above.
    attributes: [],
    version: '0.1',
    varSections: [],
    body: [],
  };
}

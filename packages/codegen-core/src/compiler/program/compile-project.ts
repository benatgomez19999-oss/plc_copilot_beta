import type { Project } from '@plccopilot/pir';
import { CodegenError } from '../../types.js';
import {
  dedupDiagnostics,
  diag,
  firstError,
  sortDiagnostics,
  toArtifactDiagnostic,
  type Diagnostic,
} from '../diagnostics.js';
import { codegenErrorFromDiagnostic } from '../errors.js';
import { equipmentTypePath } from '../diagnostic-paths.js';
import { collectAlarmDiagnostics } from './alarm-diagnostics.js';
import type { FunctionBlockIR } from '../ir/nodes.js';
import { lowerStation } from '../lowering/station.js';
import { buildEquipmentTypesIR } from './types.js';
import {
  buildDbAlarmsIR,
  buildDbParamsIR,
  buildDbRecipesIR,
} from './data-blocks.js';
import { buildFbAlarmsIR } from './fb-alarms.js';
import { buildTagTablesIR } from './tag-tables.js';
import type {
  CompilerFeatures,
  DataBlockArtifactIR,
  ManifestIR,
  ProgramIR,
} from './program.js';

// Sprint 87A — `valve_onoff` joins the core scope so the vendor-neutral
// pipeline can lower it. Per-target readiness still gates which backends
// are willing to render it (only CODESYS in v0; Siemens / Rockwell still
// reject via `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`).
const SUPPORTED_TYPES = new Set([
  'pneumatic_cylinder_2pos',
  'motor_simple',
  'sensor_discrete',
  'valve_onoff',
]);

const DEFAULT_GENERATED_AT = '1970-01-01T00:00:00Z';

export interface CompileProjectOptions {
  /** Wall-clock stamp for the manifest. Backends may override at render. */
  generatedAt?: string;
  /** Compiler feature flags. See `CompilerFeatures`. */
  features?: Partial<CompilerFeatures>;
  /**
   * Legacy nested options shape. Accepted for backward compatibility with
   * the Siemens-flavoured wrapper that used to live in codegen-siemens.
   * Only `generatedAt` is consumed by core; the rest is ignored.
   */
  manifest?: { generatedAt?: string; [key: string]: unknown };
}

/**
 * Resolve the final `CompilerFeatures` by layering user-supplied overrides
 * on top of PIR-derived defaults.
 */
export function resolveFeatures(
  requested: Partial<CompilerFeatures> | undefined,
  hasAlarms: boolean,
): CompilerFeatures {
  const r = requested ?? {};
  const useDbAlarms = r.useDbAlarms ?? hasAlarms;
  return {
    useDbAlarms,
    emitFbAlarms: r.emitFbAlarms ?? useDbAlarms,
    emitDiagnosticsInManifest: r.emitDiagnosticsInManifest ?? true,
    strictDiagnostics: r.strictDiagnostics ?? false,
  };
}

/**
 * Vendor-neutral compile pipeline: PIR → ProgramIR.
 *
 *   - No backend paths, no extensions, no directory prefixes.
 *   - No `target.vendor` default — backends fill at render time.
 *   - No `manifest.path` / `manifest.generator` / `manifest.artifactPaths`
 *     — backends fill at render time.
 *   - Tag tables carry logical rows; the CSV/GVL/Tag-list rendering happens
 *     in each backend.
 */
export function compileProject(
  project: Project,
  options?: CompileProjectOptions,
): ProgramIR {
  const machine = project.machines[0];
  if (!machine) {
    // Sprint 40 — surface the canonical PIR path so a CLI / web user
    // can jump straight to the missing array, plus an actionable hint.
    throw new CodegenError(
      'NO_MACHINE',
      `Project "${project.id}" must contain at least one machine for codegen.`,
      {
        path: 'machines',
        hint: 'Add one machine to the PIR project before generating artifacts.',
      },
    );
  }

  // --- Scope check: fail fast for out-of-scope equipment types ---
  for (let si = 0; si < machine.stations.length; si++) {
    const s = machine.stations[si]!;
    for (let ei = 0; ei < s.equipment.length; ei++) {
      const eq = s.equipment[ei]!;
      if (!SUPPORTED_TYPES.has(eq.type)) {
        // Sprint 40 — point at the offending `type` field, attach the
        // station id, and put the equipment id in `symbol` so the
        // web banner / CLI surface it as a separate metadata chip.
        // The hint enumerates the supported types so the integrator
        // doesn't have to look them up.
        const supported = Array.from(SUPPORTED_TYPES).join(', ');
        throw new CodegenError(
          'UNSUPPORTED_EQUIPMENT',
          `Equipment "${eq.id}" has type "${eq.type}" which is not supported by the core pipeline.`,
          {
            path: equipmentTypePath(0, si, ei),
            stationId: s.id,
            symbol: eq.id,
            hint: `Change ${eq.id}.type to one of the supported values (${supported}) or extend the backend support table.`,
          },
        );
      }
    }
  }

  // --- Feature resolution ---
  const features = resolveFeatures(options?.features, machine.alarms.length > 0);

  const programDiagnostics: Diagnostic[] = [];

  // When the project has alarms but the compiler is told NOT to use DB_Alarms,
  // station FBs fall back to loose `<id>` writes. Surface as info so downstream
  // tooling (agents, HMI) knows the alarm contract in play.
  if (machine.alarms.length > 0 && !features.useDbAlarms) {
    programDiagnostics.push(
      diag(
        'info',
        'ALARMS_AS_LOOSE_TAGS',
        `feature useDbAlarms=false: station FBs write alarms as loose tags; DB_Alarms / FB_Alarms are NOT emitted`,
        {
          hint: 'set features.useDbAlarms=true (or omit) to route through DB_Alarms',
        },
      ),
    );
  }

  // Sprint 44 — alarm.when expressions are NOT lowered into any
  // artifact today, but a typo here would silently survive
  // generation. Run a diagnostic-first pass that pipes each
  // `alarm.when` through the existing parse + check + lower stack and
  // harvests Diagnostics decorated with `machines[<m>].alarms[<i>]
  // .when` JSON paths. The `strictDiagnostics` gate further down
  // promotes any error severity to a CodegenError throw.
  programDiagnostics.push(
    ...collectAlarmDiagnostics(machine, { machineIndex: 0 }),
  );

  // --- Per-station lowering ---
  // Sprint 42 — pass real `machineIndex` / `stationIndex` so emitted
  // diagnostics carry `machines[i].stations[j]…` JSON paths instead
  // of FB-name placeholders. Single-machine semantics preserved
  // (`machineIndex` is hardcoded `0` because compileProject reads
  // `project.machines[0]` exclusively today; multi-machine support
  // is a separate sprint).
  const blocks: FunctionBlockIR[] = [];
  for (let stationIndex = 0; stationIndex < machine.stations.length; stationIndex++) {
    const station = machine.stations[stationIndex]!;
    const { fb, diagnostics } = lowerStation(machine, station, {
      useDbAlarms: features.useDbAlarms,
      pathContext: { machineIndex: 0, stationIndex },
    });
    programDiagnostics.push(...diagnostics);
    const err = firstError(diagnostics);
    if (err) {
      throw codegenErrorFromDiagnostic(err);
    }
    blocks.push(fb);
  }

  // --- FB_Alarms (project-scoped block) ---
  if (features.emitFbAlarms && features.useDbAlarms && machine.alarms.length > 0) {
    const fbAlarms = buildFbAlarmsIR(project);
    if (fbAlarms) blocks.push(fbAlarms);
  }

  // --- UDTs ---
  const typeArtifacts = buildEquipmentTypesIR(project);

  // --- DBs ---
  const dataBlocks = collectDataBlocks(project, features);

  // --- Tag tables (vendor-neutral rows) ---
  const tagTables = buildTagTablesIR(project);

  // --- Aggregate diagnostics ---
  const aggregatedDiagnostics = sortDiagnostics(
    dedupDiagnostics(programDiagnostics),
  );

  // --- Strict mode: error diagnostics that escaped per-station throws ---
  if (features.strictDiagnostics) {
    const err = firstError(aggregatedDiagnostics);
    if (err) {
      throw codegenErrorFromDiagnostic(err);
    }
  }

  const manifest = buildManifest(
    project,
    options,
    aggregatedDiagnostics,
    features,
  );

  return {
    projectId: project.id,
    projectName: project.name,
    pirVersion: project.pir_version,
    target: {},
    blocks,
    typeArtifacts,
    dataBlocks,
    tagTables,
    manifest,
    diagnostics: aggregatedDiagnostics,
    features,
  };
}

function collectDataBlocks(
  project: Project,
  features: CompilerFeatures,
): DataBlockArtifactIR[] {
  const out: DataBlockArtifactIR[] = [];
  const params = buildDbParamsIR(project);
  if (params) out.push(params);
  const recipes = buildDbRecipesIR(project);
  if (recipes) out.push(recipes);
  if (features.useDbAlarms) {
    const alarms = buildDbAlarmsIR(project);
    if (alarms) out.push(alarms);
  }
  return out;
}

/**
 * Vendor-neutral manifest metadata. Backends overlay `path`, `generator`,
 * `target`, and `artifactPaths` at render time.
 */
function buildManifest(
  project: Project,
  options: CompileProjectOptions | undefined,
  diagnostics: Diagnostic[],
  features: CompilerFeatures,
): ManifestIR {
  const generatedAt =
    options?.generatedAt ??
    options?.manifest?.generatedAt ??
    DEFAULT_GENERATED_AT;

  return {
    pirVersion: project.pir_version,
    projectId: project.id,
    projectName: project.name,
    generatedAt,
    compilerDiagnostics: diagnostics.map(toArtifactDiagnostic),
    features,
  };
}

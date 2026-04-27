import type { Machine, Project } from '@plccopilot/pir';
import { CliError, formatError } from '../errors.js';
import { readProjectFromFile } from '../io/read-project.js';
import {
  buildErrorPayload,
  buildInspectPayload,
  writeJson,
} from '../json-output.js';
import type { CliIO } from '../cli.js';

export interface InspectArgs {
  input: string;
  /** Sprint 45 — emit a single stable JSON payload to stdout. */
  json?: boolean;
  /** Sprint 45 — include stack traces in serialized errors. */
  debug?: boolean;
}

/**
 * Run the `inspect` command.
 *
 * Prints a human-readable summary of the project: id/name, PIR version,
 * machine count, station list, and per-machine counts (equipment, IO,
 * parameters, recipes, alarms).
 *
 * Exit codes:
 *   0 — printed summary successfully
 *   1 — file/JSON/schema error
 */
export async function runInspect(
  args: InspectArgs,
  io: CliIO,
): Promise<number> {
  let project: Project;
  try {
    project = readProjectFromFile(args.input);
  } catch (e) {
    if (args.json) {
      writeJson(io, buildErrorPayload('inspect', e, args.debug ?? false));
      return e instanceof CliError ? e.code : 1;
    }
    io.error(formatError(e));
    return e instanceof CliError ? e.code : 1;
  }

  if (args.json) {
    writeJson(io, buildInspectPayload(project));
    return 0;
  }

  io.log(`Project: ${project.id} (${project.name})`);
  io.log(`PIR version: ${project.pir_version}`);
  io.log(`Machines: ${project.machines.length}`);

  for (const m of project.machines) {
    printMachine(io, m);
  }

  io.log('');
  io.log(
    'Supported targets: siemens (production), codesys (experimental), rockwell (experimental)',
  );

  return 0;
}

function printMachine(io: CliIO, m: Machine): void {
  const eqCount = m.stations.reduce((acc, s) => acc + s.equipment.length, 0);

  io.log('');
  io.log(`  Machine: ${m.id} (${m.name})`);
  io.log(`    stations:    ${m.stations.length}`);
  io.log(`    equipment:   ${eqCount}`);
  io.log(`    io:          ${m.io.length}`);
  io.log(`    parameters:  ${m.parameters.length}`);
  io.log(`    recipes:     ${m.recipes.length}`);
  io.log(`    alarms:      ${m.alarms.length}`);

  for (const s of m.stations) {
    const states = s.sequence.states.length;
    const transitions = s.sequence.transitions.length;
    io.log(
      `      • ${s.id} (${s.name}): ${s.equipment.length} eq, ${states} states, ${transitions} transitions`,
    );
  }
}

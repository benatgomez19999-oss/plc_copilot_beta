import { validate, type Issue, type Project } from '@plccopilot/pir';
import { CliError, formatError } from '../errors.js';
import { readProjectFromFile } from '../io/read-project.js';
import {
  buildErrorPayload,
  buildValidatePayload,
  writeJson,
} from '../json-output.js';
import type { CliIO } from '../cli.js';

export interface ValidateArgs {
  input: string;
  /** Sprint 45 — emit a single stable JSON payload to stdout. */
  json?: boolean;
  /** Sprint 45 — include stack traces in serialized errors. */
  debug?: boolean;
}

/**
 * Run the `validate` command.
 *
 * Exit codes:
 *   0 — JSON parsed, schema OK, validate(project) report.ok === true
 *   1 — file/JSON/schema error (couldn't reach validate())
 *   2 — validate() report contains at least one severity=error issue
 */
export async function runValidate(
  args: ValidateArgs,
  io: CliIO,
): Promise<number> {
  let project: Project;
  try {
    project = readProjectFromFile(args.input);
  } catch (e) {
    if (args.json) {
      writeJson(
        io,
        buildErrorPayload('validate', e, args.debug ?? false),
      );
      return e instanceof CliError ? e.code : 1;
    }
    io.error(formatError(e));
    return e instanceof CliError ? e.code : 1;
  }

  const report = validate(project);

  if (args.json) {
    writeJson(io, buildValidatePayload(project, report));
  } else {
    for (const issue of report.issues) printIssue(io, issue);
    const counts = countIssues(report.issues);
    io.log(
      `Validation: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info`,
    );
  }

  return report.ok ? 0 : 2;
}

function printIssue(io: CliIO, issue: Issue): void {
  const line = `[${issue.severity}] ${issue.rule}: ${issue.message} (${issue.path})`;
  if (issue.severity === 'error') io.error(line);
  else io.log(line);
}

function countIssues(issues: readonly Issue[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  const out = { errors: 0, warnings: 0, info: 0 };
  for (const i of issues) {
    if (i.severity === 'error') out.errors++;
    else if (i.severity === 'warning') out.warnings++;
    else out.info++;
  }
  return out;
}

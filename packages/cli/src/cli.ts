import { CliError, formatError } from './errors.js';
import {
  runGenerate,
  type GenerateBackend,
} from './commands/generate.js';
import { runValidate } from './commands/validate.js';
import { runInspect } from './commands/inspect.js';
import { runSchema } from './commands/schema.js';
import { buildErrorPayload, writeJson } from './json-output.js';

/**
 * Output channel abstraction. Production wires this to `console`; tests
 * pass a buffered IO so assertions can inspect what was printed.
 */
export interface CliIO {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

export const consoleIO: CliIO = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string>;
}

/**
 * Tiny `--flag value` / `--flag=value` parser. The first non-flag token is
 * the subcommand. Boolean flags (no value) get the literal `'true'`. We
 * intentionally avoid pulling in a CLI framework — argv shape is small and
 * the dispatcher does its own validation per-command.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!command && !a.startsWith('-')) {
      command = a;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = 'true';
        }
      }
    }
  }
  return { command, flags };
}

/**
 * Sprint 45 — does the user-supplied flag map carry the boolean
 * `--name` flag? Accepts the parser's `'true'` shorthand AND
 * explicit `--name=true` / `--name=1`; rejects `false`/`0`/missing.
 */
export function hasFlag(
  flags: Record<string, string>,
  name: string,
): boolean {
  const v = flags[name];
  return v === 'true' || v === '1';
}

const VALID_BACKENDS = new Set<GenerateBackend>([
  'siemens',
  'codesys',
  'rockwell',
  'all',
]);

const HELP = `plccopilot — PLC Copilot codegen CLI

Usage:
  plccopilot <command> [options]

Commands:
  generate   Compile a PIR JSON to backend artifacts on disk
  validate   Run PIR schema + domain rules against a PIR JSON
  inspect    Print a quick summary of a PIR JSON
  schema     Print JSON Schema for CLI JSON outputs
  help       Show this message

Options (per command):
  generate:
    --input <path>      PIR JSON file (required)
    --backend <name>    siemens | codesys | rockwell | all (required)
    --out <dir>         Output directory (required)
    --generated-at <ts> Optional ISO timestamp embedded in the manifest
  validate:
    --input <path>      PIR JSON file (required)
  inspect:
    --input <path>      PIR JSON file (required)
  schema:
    --name <id>         cli-result (default) | serialized-compiler-error
                        | generate-summary | web-zip-summary
    --out <dir>         Write schema file(s) to <dir> instead of stdout.
                        Without --name, writes every published schema.
    --check <dir>       Read-only sync verification — exit 0 if <dir>
                        matches the published schema(s) byte-for-byte,
                        exit 1 with a missing / changed / unexpected
                        report otherwise. Mutually exclusive with --out.

Schema:
  plccopilot schema
  plccopilot schema --name cli-result
  plccopilot schema --name generate-summary
  plccopilot schema --out ./schemas
  plccopilot schema --name serialized-compiler-error --out ./schemas
  plccopilot schema --check ./schemas
  plccopilot schema --name web-zip-summary --check ./schemas

Global options:
  --json              Emit a machine-readable JSON result on stdout
                      (suitable for CI / agents). Disables human prints.
  --debug             Include stack traces in serialized errors. Has no
                      effect on success output.

Exit codes:
  0  success
  1  unrecoverable error (file / JSON / schema / codegen / write)
  2  command succeeded but report contains errors
`;

/**
 * Dispatch a command. `argv` should be `process.argv.slice(2)`.
 * Returns the exit code; the caller (bin entry) calls `process.exit`.
 */
export async function main(
  argv: readonly string[],
  io: CliIO = consoleIO,
): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const json = hasFlag(flags, 'json');
  const debug = hasFlag(flags, 'debug');

  if (!command || command === 'help' || flags.help === 'true') {
    // Help stays human-readable even with `--json` — there is no
    // "JSON help" use case worth supporting today.
    io.log(HELP);
    return 0;
  }

  try {
    switch (command) {
      case 'generate':
        return await runGenerate(
          {
            input: requireFlag(flags, 'input', 'generate'),
            backend: requireBackend(flags),
            out: requireFlag(flags, 'out', 'generate'),
            generatedAt: flags['generated-at'],
            json,
            debug,
          },
          io,
        );
      case 'validate':
        return await runValidate(
          {
            input: requireFlag(flags, 'input', 'validate'),
            json,
            debug,
          },
          io,
        );
      case 'inspect':
        return await runInspect(
          {
            input: requireFlag(flags, 'input', 'inspect'),
            json,
            debug,
          },
          io,
        );
      case 'schema':
        // Sprint 46 — `schema` always prints a JSON Schema, never a
        // `CliJsonResult`. The `--json` / `--debug` flags don't apply
        // (success output is already JSON; a hard error would only
        // come from typos in `--name` and is fine on stderr).
        // Sprint 50 — `--out <dir>` writes the schema(s) to disk
        // instead of stdout, portably regenerating the static files.
        // Sprint 52 — `--check <dir>` is read-only sync verification
        // (CI / pre-push guard); mutually exclusive with `--out`.
        return await runSchema(
          {
            name: flags.name,
            out: flags.out,
            check: flags.check,
          },
          io,
        );
      default: {
        // Sprint 45 — JSON mode swallows the human "unknown command"
        // lines so consumers always see a structured payload on
        // stdout (and an empty stderr) when they asked for JSON.
        if (json) {
          writeJson(
            io,
            buildErrorPayload(
              'unknown',
              new CliError(`unknown command "${command}"`),
              debug,
            ),
          );
          return 1;
        }
        io.error(`error: unknown command "${command}"`);
        io.error(`run \`plccopilot help\` for usage`);
        return 1;
      }
    }
  } catch (e) {
    // Sprint 45 — `requireFlag` / `requireBackend` raise CliError
    // BEFORE the per-command handler ever runs, so the JSON payload
    // has to be emitted from this catch. We have the original
    // `command` string from argv parsing — narrow it to the JSON
    // command union when it's one of the known commands.
    if (json) {
      const cmdName: 'generate' | 'validate' | 'inspect' | 'unknown' =
        command === 'generate' ||
        command === 'validate' ||
        command === 'inspect'
          ? command
          : 'unknown';
      writeJson(io, buildErrorPayload(cmdName, e, debug));
      return e instanceof CliError ? e.code : 1;
    }
    io.error(formatError(e));
    return e instanceof CliError ? e.code : 1;
  }
}

function requireFlag(
  flags: Record<string, string>,
  name: string,
  command: string,
): string {
  const v = flags[name];
  if (!v || v === 'true') {
    throw new CliError(`missing required flag --${name} for "${command}"`, 1);
  }
  return v;
}

function requireBackend(flags: Record<string, string>): GenerateBackend {
  const v = requireFlag(flags, 'backend', 'generate');
  if (!VALID_BACKENDS.has(v as GenerateBackend)) {
    throw new CliError(
      `invalid --backend "${v}". Valid: siemens, codesys, rockwell, all`,
      1,
    );
  }
  return v as GenerateBackend;
}

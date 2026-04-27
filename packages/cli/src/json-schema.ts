/**
 * Sprint 46 — official JSON Schemas (draft 2020-12) for the CLI's
 * machine-readable outputs introduced in Sprint 45 and the
 * `SerializedCompilerError` envelope from Sprint 39.
 *
 * Scope:
 *   - Schemas live in this file as plain JS objects (no codegen, no
 *     runtime validator). CI / agents that already run Ajv can fetch
 *     them via the `plccopilot schema` subcommand and validate every
 *     `--json` payload they consume.
 *   - This file exports the schemas, a name index, and a `getCliJsonSchema`
 *     accessor that returns a deep-cloned copy so callers can mutate
 *     freely without poisoning subsequent reads.
 *   - Schemas are MANUAL; they do NOT auto-track the TypeScript types
 *     in `json-output.ts`. Any field added there must be mirrored
 *     here in the same sprint — see the regression test cases in
 *     `tests/schema.spec.ts` for the contract pin.
 *
 * Versioning: bump `CLI_JSON_SCHEMA_VERSION` when the wire shape
 * changes in a non-additive way.
 */

export const CLI_JSON_SCHEMA_VERSION = 1 as const;

export type CliSchemaName =
  | 'cli-result'
  | 'serialized-compiler-error'
  | 'generate-summary'
  | 'web-zip-summary';

const CLI_SCHEMA_NAMES: readonly CliSchemaName[] = [
  'cli-result',
  'serialized-compiler-error',
  'generate-summary',
  'web-zip-summary',
] as const;

export function listCliSchemaNames(): readonly CliSchemaName[] {
  return CLI_SCHEMA_NAMES;
}

export function isCliSchemaName(value: string): value is CliSchemaName {
  return (CLI_SCHEMA_NAMES as readonly string[]).includes(value);
}

/**
 * Sprint 48 — canonical filename for each schema, used both by the
 * `--out` writer and by the static-file drift tests. Kept as a thin
 * exhaustive switch so a new `CliSchemaName` triggers a TypeScript
 * error here at compile time before anywhere else.
 */
export function cliSchemaFileName(name: CliSchemaName): string {
  switch (name) {
    case 'cli-result':
      return 'cli-result.schema.json';
    case 'serialized-compiler-error':
      return 'serialized-compiler-error.schema.json';
    case 'generate-summary':
      return 'generate-summary.schema.json';
    case 'web-zip-summary':
      return 'web-zip-summary.schema.json';
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown schema "${String(exhaustive)}"`);
    }
  }
}

export interface CliJsonSchemaEntry {
  name: CliSchemaName;
  fileName: string;
  schema: unknown;
}

/**
 * Sprint 48 — enumerable view over every published schema. `schema`
 * is a deep-cloned copy (via `getCliJsonSchema`), safe to mutate or
 * serialise without affecting subsequent calls.
 */
export function getCliJsonSchemaEntries(): readonly CliJsonSchemaEntry[] {
  return listCliSchemaNames().map((name) => ({
    name,
    fileName: cliSchemaFileName(name),
    schema: getCliJsonSchema(name),
  }));
}

// =============================================================================
// SerializedCompilerError schema
// =============================================================================

/**
 * Mirrors the `SerializedCompilerError` interface declared in
 * `@plccopilot/codegen-core` (Sprint 39 + extensions). `name` and
 * `message` are the only required fields; everything else is
 * additive metadata. `stack` is allowed but only ever populated when
 * the user passes `--debug` to the CLI (Sprint 45).
 */
export const SERIALIZED_COMPILER_ERROR_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://plccopilot.dev/schemas/serialized-compiler-error.schema.json',
  title: 'PLC Copilot Serialized Compiler Error',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'message'],
  properties: {
    name: { type: 'string', minLength: 1 },
    code: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    stationId: { type: 'string', minLength: 1 },
    symbol: { type: 'string', minLength: 1 },
    hint: { type: 'string', minLength: 1 },
    cause: { type: 'string', minLength: 1 },
    stack: { type: 'string', minLength: 1 },
  },
} as const;

// =============================================================================
// CliJsonResult schema (oneOf: generate | validate | inspect | error)
// =============================================================================

/**
 * Discriminated union covering every payload the CLI emits in JSON
 * mode. Discrimination keys are `(ok, command)`:
 *
 *   - generate success      → { ok: true,  command: 'generate' }
 *   - validate result       → { ok: bool,  command: 'validate' }   (ok=false here is NOT an error envelope; the report failed)
 *   - inspect success       → { ok: true,  command: 'inspect'  }
 *   - error envelope        → { ok: false, command: 'generate'|'validate'|'inspect'|'unknown', error: SerializedCompilerError }
 *
 * `validate` with `ok: false` is the "report failed" branch (one or
 * more `severity: error` issues). It is NOT the same as the error
 * envelope, which is reserved for hard errors (file IO, schema parse,
 * codegen throws).
 */
export const CLI_JSON_RESULT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://plccopilot.dev/schemas/cli-result.schema.json',
  title: 'PLC Copilot CLI JSON Result',
  description:
    "Wire shape emitted to stdout by 'plccopilot generate|validate|inspect --json'.",
  oneOf: [
    { $ref: '#/$defs/CliGenerateJsonResult' },
    { $ref: '#/$defs/CliValidateJsonResult' },
    { $ref: '#/$defs/CliInspectJsonResult' },
    { $ref: '#/$defs/CliJsonErrorResult' },
  ],
  $defs: {
    BackendId: {
      type: 'string',
      enum: ['siemens', 'codesys', 'rockwell'],
    },
    BackendIdOrAll: {
      type: 'string',
      enum: ['siemens', 'codesys', 'rockwell', 'all'],
    },
    CommandName: {
      type: 'string',
      enum: ['generate', 'validate', 'inspect', 'unknown'],
    },
    DiagnosticsCounts: {
      type: 'object',
      additionalProperties: false,
      required: ['errors', 'warnings', 'info'],
      properties: {
        errors: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
        info: { type: 'integer', minimum: 0 },
      },
    },
    SerializedCompilerError: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'message'],
      properties: {
        name: { type: 'string', minLength: 1 },
        code: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        stationId: { type: 'string', minLength: 1 },
        symbol: { type: 'string', minLength: 1 },
        hint: { type: 'string', minLength: 1 },
        cause: { type: 'string', minLength: 1 },
        stack: { type: 'string', minLength: 1 },
      },
    },
    ValidationIssue: {
      type: 'object',
      additionalProperties: false,
      required: ['severity', 'rule', 'message'],
      properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        rule: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
      },
    },
    GenerateRunSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['backend', 'artifact_count', 'diagnostics'],
      properties: {
        backend: { $ref: '#/$defs/BackendId' },
        artifact_count: { type: 'integer', minimum: 0 },
        diagnostics: { $ref: '#/$defs/DiagnosticsCounts' },
      },
    },
    MachineInspectSummary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'stations',
        'equipment',
        'io',
        'alarms',
        'parameters',
        'recipes',
      ],
      properties: {
        id: { type: 'string', minLength: 1 },
        // The TS interface marks `name` optional — leaving it that way
        // because PIR Machine.name is typed as required but the
        // builder also handles a missing value defensively.
        name: { type: 'string', minLength: 1 },
        stations: { type: 'integer', minimum: 0 },
        equipment: { type: 'integer', minimum: 0 },
        io: { type: 'integer', minimum: 0 },
        alarms: { type: 'integer', minimum: 0 },
        parameters: { type: 'integer', minimum: 0 },
        recipes: { type: 'integer', minimum: 0 },
      },
    },

    // ---- Concrete payload shapes ----

    CliGenerateJsonResult: {
      type: 'object',
      additionalProperties: false,
      required: [
        'ok',
        'command',
        'generated_at',
        'backend',
        'out_dir',
        'artifact_count',
        'written_files',
        'diagnostics',
        'summary_path',
      ],
      properties: {
        ok: { type: 'boolean', const: true },
        command: { type: 'string', const: 'generate' },
        generated_at: { type: 'string', format: 'date-time' },
        backend: { $ref: '#/$defs/BackendIdOrAll' },
        out_dir: { type: 'string', minLength: 1 },
        artifact_count: { type: 'integer', minimum: 0 },
        written_files: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        diagnostics: { $ref: '#/$defs/DiagnosticsCounts' },
        runs: {
          type: 'array',
          items: { $ref: '#/$defs/GenerateRunSummary' },
        },
        summary_path: { type: 'string', minLength: 1 },
      },
    },

    CliValidateJsonResult: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'command', 'generated_at', 'issues', 'counts'],
      properties: {
        ok: { type: 'boolean' },
        command: { type: 'string', const: 'validate' },
        generated_at: { type: 'string', format: 'date-time' },
        project_id: { type: 'string', minLength: 1 },
        project_name: { type: 'string', minLength: 1 },
        issues: {
          type: 'array',
          items: { $ref: '#/$defs/ValidationIssue' },
        },
        counts: { $ref: '#/$defs/DiagnosticsCounts' },
      },
    },

    CliInspectJsonResult: {
      type: 'object',
      additionalProperties: false,
      required: [
        'ok',
        'command',
        'generated_at',
        'project',
        'counts',
        'machines',
        'supported_backends',
      ],
      properties: {
        ok: { type: 'boolean', const: true },
        command: { type: 'string', const: 'inspect' },
        generated_at: { type: 'string', format: 'date-time' },
        project: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'pir_version'],
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            pir_version: { type: 'string', minLength: 1 },
          },
        },
        counts: {
          type: 'object',
          additionalProperties: false,
          required: [
            'machines',
            'stations',
            'equipment',
            'io',
            'alarms',
            'parameters',
            'recipes',
          ],
          properties: {
            machines: { type: 'integer', minimum: 0 },
            stations: { type: 'integer', minimum: 0 },
            equipment: { type: 'integer', minimum: 0 },
            io: { type: 'integer', minimum: 0 },
            alarms: { type: 'integer', minimum: 0 },
            parameters: { type: 'integer', minimum: 0 },
            recipes: { type: 'integer', minimum: 0 },
          },
        },
        machines: {
          type: 'array',
          items: { $ref: '#/$defs/MachineInspectSummary' },
        },
        supported_backends: {
          type: 'array',
          items: { $ref: '#/$defs/BackendIdOrAll' },
        },
      },
    },

    CliJsonErrorResult: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'command', 'generated_at', 'error'],
      properties: {
        ok: { type: 'boolean', const: false },
        command: { $ref: '#/$defs/CommandName' },
        generated_at: { type: 'string', format: 'date-time' },
        error: { $ref: '#/$defs/SerializedCompilerError' },
      },
    },
  },
} as const;

// =============================================================================
// generate-summary schema (sprint 49)
//
// Validates the `summary.json` file written to disk by `plccopilot
// generate`. The shape is **distinct** from `CliGenerateJsonResult`:
//   - `summary.json` carries `artifacts: string[]` (PIR-relative
//     paths), the CLI stdout payload carries `written_files: string[]`
//     (absolute paths).
//   - `summary.json` for `--backend all` nests every per-backend run
//     including its `artifacts` list; the stdout `runs[]` only counts.
//   - No `generated_at` in `summary.json` today (the CLI stdout has
//     it; summary intentionally stays content-deterministic).
// =============================================================================

export const GENERATE_SUMMARY_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://plccopilot.dev/schemas/generate-summary.schema.json',
  title: 'PLC Copilot Generate Summary',
  description:
    "Shape written to <out>/summary.json by 'plccopilot generate'.",
  oneOf: [
    { $ref: '#/$defs/SingleBackendSummary' },
    { $ref: '#/$defs/AllBackendsSummary' },
  ],
  $defs: {
    BackendId: {
      type: 'string',
      enum: ['siemens', 'codesys', 'rockwell'],
    },
    DiagnosticsCounts: {
      type: 'object',
      additionalProperties: false,
      required: ['errors', 'warnings', 'info'],
      properties: {
        errors: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
        info: { type: 'integer', minimum: 0 },
      },
    },
    SingleBackendSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['backend', 'artifact_count', 'diagnostics', 'artifacts'],
      properties: {
        backend: { $ref: '#/$defs/BackendId' },
        artifact_count: { type: 'integer', minimum: 0 },
        diagnostics: { $ref: '#/$defs/DiagnosticsCounts' },
        artifacts: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    AllBackendsSummary: {
      type: 'object',
      additionalProperties: false,
      required: ['backend', 'runs'],
      properties: {
        backend: { type: 'string', const: 'all' },
        runs: {
          type: 'array',
          items: { $ref: '#/$defs/SingleBackendSummary' },
        },
      },
    },
  },
} as const;

// =============================================================================
// web-zip-summary schema (sprint 51)
//
// Validates the `summary.json` file embedded inside the artifacts ZIP
// downloaded from the Web MVP (`App.tsx:handleDownloadZip` →
// `downloadArtifactsZip` → `summary.json` at zip root).
//
// Distinct from `generate-summary` (CLI on-disk) by design:
//   - Web summary carries `generated_at` (the Web has no determinism
//     contract; the user clicks "Download" at a wall-clock time).
//   - Counts live FLAT at the root (`errors`/`warnings`/`info`)
//     mirroring the pre-sprint-51 inline literal — preserved
//     verbatim to avoid breaking integrators already parsing
//     downloaded ZIPs.
//   - `artifactCount` is camelCase (inherited from `CompileSummary`);
//     `generated_at` is snake_case (matches every other PLC Copilot
//     timestamp). Inconsistency is observable but historic.
// =============================================================================

export const WEB_ZIP_SUMMARY_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://plccopilot.dev/schemas/web-zip-summary.schema.json',
  title: 'PLC Copilot Web ZIP Summary',
  description:
    'Shape written as summary.json inside the Web MVP artifacts ZIP.',
  type: 'object',
  additionalProperties: false,
  required: [
    'backend',
    'artifactCount',
    'errors',
    'warnings',
    'info',
    'generated_at',
  ],
  properties: {
    backend: {
      type: 'string',
      enum: ['siemens', 'codesys', 'rockwell', 'all'],
    },
    artifactCount: { type: 'integer', minimum: 0 },
    errors: { type: 'integer', minimum: 0 },
    warnings: { type: 'integer', minimum: 0 },
    info: { type: 'integer', minimum: 0 },
    generated_at: { type: 'string', format: 'date-time' },
  },
} as const;

// =============================================================================
// Public accessor
// =============================================================================

/**
 * Returns a deep-cloned copy of the schema so consumers can freely
 * mutate / freeze / serialise without affecting subsequent calls.
 * Cost: a single round-trip through `JSON.parse(JSON.stringify(...))`,
 * which is cheap given the schemas are <2 KB each.
 */
export function getCliJsonSchema(name: CliSchemaName): unknown {
  switch (name) {
    case 'cli-result':
      return JSON.parse(JSON.stringify(CLI_JSON_RESULT_JSON_SCHEMA));
    case 'serialized-compiler-error':
      return JSON.parse(
        JSON.stringify(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA),
      );
    case 'generate-summary':
      return JSON.parse(JSON.stringify(GENERATE_SUMMARY_JSON_SCHEMA));
    case 'web-zip-summary':
      return JSON.parse(JSON.stringify(WEB_ZIP_SUMMARY_JSON_SCHEMA));
    default: {
      // Defence-in-depth — `isCliSchemaName` already gates this at the
      // CLI boundary, but the function is exported for tooling.
      const exhaustive: never = name;
      throw new Error(`unknown schema "${String(exhaustive)}"`);
    }
  }
}

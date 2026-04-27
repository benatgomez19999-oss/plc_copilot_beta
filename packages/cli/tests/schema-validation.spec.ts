import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CodegenError,
  serializeCompilerError,
} from '@plccopilot/codegen-core';
import {
  CLI_JSON_RESULT_JSON_SCHEMA,
  SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
  getCliJsonSchema,
} from '../src/json-schema.js';
import {
  buildErrorPayload,
  buildGeneratePayload,
  buildInspectPayload,
  buildValidatePayload,
} from '../src/json-output.js';
import { runGenerate } from '../src/commands/generate.js';
import { runValidate } from '../src/commands/validate.js';
import { runInspect } from '../src/commands/inspect.js';
import { runSchema } from '../src/commands/schema.js';
import { main } from '../src/cli.js';
import {
  validateAgainstSchema,
  type SchemaValidationResult,
} from './schema-validator.js';
import {
  bufferedIO,
  cleanupTmp,
  fixturePath,
  makeTmpDir,
} from './test-helpers.js';
import type { Project, ValidationReport } from '@plccopilot/pir';
import { validate as validatePir } from '@plccopilot/pir';

function loadProject(): Project {
  return JSON.parse(readFileSync(fixturePath(), 'utf-8')) as Project;
}

function expectOk(result: SchemaValidationResult, hint = ''): void {
  if (result.ok) return;
  const lines = result.issues
    .slice(0, 10)
    .map((i) => `  - ${i.path}: ${i.message}`)
    .join('\n');
  throw new Error(
    `schema validation failed${hint ? ` (${hint})` : ''}:\n${lines}`,
  );
}

// =============================================================================
// Sprint 47 — minimal validator unit tests
// =============================================================================

describe('validateAgainstSchema — minimal validator', () => {
  it('accepts an object that satisfies type/required', () => {
    const r = validateAgainstSchema(
      { name: 'x', message: 'y' },
      {
        type: 'object',
        required: ['name', 'message'],
        properties: {
          name: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    );
    expect(r.ok).toBe(true);
  });

  it('rejects when a required property is missing', () => {
    const r = validateAgainstSchema(
      { name: 'x' },
      {
        type: 'object',
        required: ['name', 'message'],
        properties: {
          name: { type: 'string' },
          message: { type: 'string' },
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/missing required property "message"/);
  });

  it('rejects extra properties when additionalProperties is false', () => {
    const r = validateAgainstSchema(
      { name: 'x', extra: true },
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('extra');
  });

  it('enforces enum membership', () => {
    const enumSchema = { type: 'string', enum: ['a', 'b', 'c'] };
    expect(validateAgainstSchema('a', enumSchema).ok).toBe(true);
    expect(validateAgainstSchema('z', enumSchema).ok).toBe(false);
  });

  it('enforces const equality', () => {
    const constSchema = { type: 'boolean', const: true };
    expect(validateAgainstSchema(true, constSchema).ok).toBe(true);
    expect(validateAgainstSchema(false, constSchema).ok).toBe(false);
  });

  it('oneOf passes when exactly one branch matches', () => {
    const schema = {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    };
    expect(validateAgainstSchema('hi', schema).ok).toBe(true);
    expect(validateAgainstSchema(42, schema).ok).toBe(true);
  });

  it('oneOf rejects when zero branches match', () => {
    const schema = {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    };
    const r = validateAgainstSchema(true, schema);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('matched zero branches');
  });

  it('oneOf rejects when multiple branches match', () => {
    const schema = {
      // Two branches both accept any non-restricted value.
      oneOf: [{ type: 'string', minLength: 0 }, { type: 'string' }],
    };
    const r = validateAgainstSchema('hi', schema);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain('matched 2 branches');
  });

  it('resolves a local $ref via $defs', () => {
    const schema = {
      $defs: { Name: { type: 'string', minLength: 1 } },
      $ref: '#/$defs/Name',
    };
    expect(validateAgainstSchema('x', schema).ok).toBe(true);
    expect(validateAgainstSchema('', schema).ok).toBe(false);
  });

  it('reports a missing $ref target', () => {
    const r = validateAgainstSchema('x', {
      $defs: {},
      $ref: '#/$defs/MissingThing',
    });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toContain(
      '$ref "#/$defs/MissingThing" does not resolve',
    );
  });

  it('integer minimum accepts equal/above and rejects below + non-integer', () => {
    const schema = { type: 'integer', minimum: 0 };
    expect(validateAgainstSchema(0, schema).ok).toBe(true);
    expect(validateAgainstSchema(7, schema).ok).toBe(true);
    expect(validateAgainstSchema(-1, schema).ok).toBe(false);
    // Non-integer numeric is rejected even though it's >= minimum.
    expect(validateAgainstSchema(1.5, schema).ok).toBe(false);
  });

  it('format date-time accepts ISO strings, rejects gibberish', () => {
    const schema = { type: 'string', format: 'date-time' };
    expect(
      validateAgainstSchema('2026-04-26T10:00:00.000Z', schema).ok,
    ).toBe(true);
    expect(validateAgainstSchema('not-a-date', schema).ok).toBe(false);
  });

  it('flags unsupported keywords loudly instead of silently passing', () => {
    const r = validateAgainstSchema(
      'x',
      // `anyOf` is intentionally outside the supported subset.
      { type: 'string', anyOf: [{ type: 'string' }] } as unknown,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/unsupported schema keyword/);
  });
});

// =============================================================================
// Sprint 47 — pure builders validate against the published schemas
// =============================================================================

describe('CLI payload builders validate against cli-result schema', () => {
  it('buildGeneratePayload (single backend) validates', () => {
    const payload = buildGeneratePayload({
      backend: 'siemens',
      outDir: '/abs/out',
      artifactCount: 9,
      writtenFiles: ['/abs/out/siemens/FB_StLoad.scl'],
      diagnostics: { errors: 0, warnings: 1, info: 2 },
      summaryPath: '/abs/out/summary.json',
    });
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('buildGeneratePayload (--backend all) with runs validates', () => {
    const payload = buildGeneratePayload({
      backend: 'all',
      outDir: '/abs/out',
      artifactCount: 27,
      writtenFiles: ['/abs/out/siemens/FB.scl', '/abs/out/codesys/FB.st'],
      diagnostics: { errors: 0, warnings: 3, info: 6 },
      summaryPath: '/abs/out/summary.json',
      runs: [
        {
          backend: 'siemens',
          artifact_count: 9,
          diagnostics: { errors: 0, warnings: 1, info: 2 },
        },
        {
          backend: 'codesys',
          artifact_count: 8,
          diagnostics: { errors: 0, warnings: 1, info: 2 },
        },
        {
          backend: 'rockwell',
          artifact_count: 10,
          diagnostics: { errors: 0, warnings: 1, info: 2 },
        },
      ],
    });
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('buildValidatePayload validates (ok=true and ok=false branches)', () => {
    const project = loadProject();
    const report = validatePir(project);
    const okPayload = buildValidatePayload(project, report);
    expectOk(validateAgainstSchema(okPayload, CLI_JSON_RESULT_JSON_SCHEMA));

    const failingReport: ValidationReport = {
      ok: false,
      issues: [
        {
          severity: 'error',
          rule: 'R-FAKE-01',
          message: 'simulated',
          path: '$.machines[0]',
        },
      ],
    };
    const failPayload = buildValidatePayload(project, failingReport);
    expectOk(validateAgainstSchema(failPayload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('buildInspectPayload validates', () => {
    const payload = buildInspectPayload(loadProject());
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('buildErrorPayload validates as error envelope', () => {
    const payload = buildErrorPayload(
      'generate',
      new Error('boom'),
      false,
    );
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });
});

// =============================================================================
// Sprint 47 — drift detectors: the validator must REJECT specific mutations
// =============================================================================

describe('schema rejects payload mutations (drift detection)', () => {
  it('generate payload with an unexpected property fails additionalProperties', () => {
    const payload = buildGeneratePayload({
      backend: 'siemens',
      outDir: '/o',
      artifactCount: 0,
      writtenFiles: [],
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      summaryPath: '/o/summary.json',
    });
    const mutated = { ...payload, unexpected: true };
    const r = validateAgainstSchema(mutated, CLI_JSON_RESULT_JSON_SCHEMA);
    expect(r.ok).toBe(false);
  });

  it('validate payload missing counts fails required check', () => {
    const project = loadProject();
    const report = validatePir(project);
    const payload = buildValidatePayload(project, report);
    const { counts: _drop, ...mutated } = payload;
    const r = validateAgainstSchema(mutated, CLI_JSON_RESULT_JSON_SCHEMA);
    expect(r.ok).toBe(false);
  });

  it('inspect payload with non-integer counts.machines fails', () => {
    const payload = buildInspectPayload(loadProject()) as unknown as {
      counts: { machines: number };
    };
    const mutated = {
      ...payload,
      counts: { ...payload.counts, machines: 1.5 },
    };
    const r = validateAgainstSchema(mutated, CLI_JSON_RESULT_JSON_SCHEMA);
    expect(r.ok).toBe(false);
  });

  it('error envelope with ok=true fails the const check', () => {
    const payload = buildErrorPayload('generate', new Error('boom'));
    const mutated = { ...payload, ok: true };
    const r = validateAgainstSchema(mutated, CLI_JSON_RESULT_JSON_SCHEMA);
    expect(r.ok).toBe(false);
  });
});

// =============================================================================
// Sprint 47 — SerializedCompilerError standalone schema
// =============================================================================

describe('SerializedCompilerError schema validates real serialised errors', () => {
  it('CodegenError with full metadata validates', () => {
    const e = new CodegenError('UNKNOWN_PARAMETER', 'msg', {
      path: 'machines[0].alarms[0].when',
      symbol: 'al_x',
      hint: 'hint',
    });
    expectOk(
      validateAgainstSchema(
        serializeCompilerError(e),
        SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
      ),
    );
  });

  it('plain Error (no code) validates', () => {
    expectOk(
      validateAgainstSchema(
        serializeCompilerError(new Error('plain')),
        SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
      ),
    );
  });

  it('extra property fails additionalProperties: false', () => {
    const baseline = serializeCompilerError(new Error('x'));
    const mutated = { ...baseline, foo: 'bar' };
    const r = validateAgainstSchema(
      mutated,
      SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
    );
    expect(r.ok).toBe(false);
  });

  it('payload without message fails required', () => {
    const r = validateAgainstSchema(
      { name: 'X' },
      SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/missing required property "message"/);
  });
});

// =============================================================================
// Sprint 47 — real CLI E2E payloads validate end-to-end
// =============================================================================

describe('CLI --json E2E payloads validate against cli-result schema', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  function parseStdout(io: ReturnType<typeof bufferedIO>): unknown {
    return JSON.parse(io.out());
  }

  it('generate --backend siemens --json produces a schema-valid payload', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp, json: true },
      io,
    );
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    expectOk(
      validateAgainstSchema(parseStdout(io), CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('generate --backend codesys --json validates', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'codesys', out: tmp, json: true },
      io,
    );
    expect(code).toBe(0);
    expectOk(
      validateAgainstSchema(parseStdout(io), CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('generate --backend rockwell --json validates', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'rockwell', out: tmp, json: true },
      io,
    );
    expect(code).toBe(0);
    expectOk(
      validateAgainstSchema(parseStdout(io), CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('generate --backend all --json validates and includes runs[]', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'all', out: tmp, json: true },
      io,
    );
    expect(code).toBe(0);
    const payload = parseStdout(io) as { runs?: unknown[] };
    expect(Array.isArray(payload.runs)).toBe(true);
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('validate --json (ok report) validates', async () => {
    const io = bufferedIO();
    const code = await runValidate(
      { input: fixturePath(), json: true },
      io,
    );
    expect(code).toBe(0);
    expectOk(
      validateAgainstSchema(parseStdout(io), CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('validate --json (schema mismatch) validates as error envelope', async () => {
    const bad = join(tmp, 'not-pir.json');
    writeFileSync(bad, JSON.stringify({ unrelated: 'shape' }), 'utf-8');
    const io = bufferedIO();
    const code = await runValidate({ input: bad, json: true }, io);
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    const payload = parseStdout(io) as { ok: boolean };
    expect(payload.ok).toBe(false);
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('inspect --json validates', async () => {
    const io = bufferedIO();
    const code = await runInspect(
      { input: fixturePath(), json: true },
      io,
    );
    expect(code).toBe(0);
    expectOk(
      validateAgainstSchema(parseStdout(io), CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('generate --json UNKNOWN_PARAMETER error envelope validates, no stderr', async () => {
    const raw = readFileSync(fixturePath(), 'utf-8');
    const project = JSON.parse(raw) as {
      machines: {
        recipes: { id: string; values: Record<string, number | boolean> }[];
      }[];
    };
    project.machines[0]!.recipes[0]!.values = {
      ...project.machines[0]!.recipes[0]!.values,
      p_ghost_param: 1,
    };
    const path = join(tmp, 'ghost.json');
    writeFileSync(path, JSON.stringify(project), 'utf-8');
    const io = bufferedIO();
    const code = await runGenerate(
      { input: path, backend: 'siemens', out: tmp, json: true },
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    expectOk(
      validateAgainstSchema(parseStdout(io), CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('generate --json --debug error envelope (with stack) still validates', async () => {
    const raw = readFileSync(fixturePath(), 'utf-8');
    const project = JSON.parse(raw) as {
      machines: {
        recipes: { id: string; values: Record<string, number | boolean> }[];
      }[];
    };
    project.machines[0]!.recipes[0]!.values = {
      ...project.machines[0]!.recipes[0]!.values,
      p_ghost_param: 1,
    };
    const path = join(tmp, 'ghost-debug.json');
    writeFileSync(path, JSON.stringify(project), 'utf-8');
    const io = bufferedIO();
    const code = await runGenerate(
      {
        input: path,
        backend: 'siemens',
        out: tmp,
        json: true,
        debug: true,
      },
      io,
    );
    expect(code).toBe(1);
    const payload = parseStdout(io) as { error: { stack?: string } };
    expect(typeof payload.error.stack).toBe('string');
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });

  it('main(["unknown", "--json"]) emits a schema-valid error envelope with command="unknown"', async () => {
    const io = bufferedIO();
    const code = await main(['totally-unknown', '--json'], io);
    expect(code).toBe(1);
    const payload = parseStdout(io) as { command: string; ok: boolean };
    expect(payload.command).toBe('unknown');
    expect(payload.ok).toBe(false);
    expectOk(validateAgainstSchema(payload, CLI_JSON_RESULT_JSON_SCHEMA));
  });
});

// =============================================================================
// Sprint 47 — schema command emits a JSON Schema, NOT a CliJsonResult
// =============================================================================

describe('schema command emits JSON Schema, not CliJsonResult', () => {
  it('schema output parses fine but does NOT validate as CliJsonResult', async () => {
    const io = bufferedIO();
    const code = await runSchema({}, io);
    expect(code).toBe(0);
    const schemaPayload = JSON.parse(io.out());
    const r = validateAgainstSchema(
      schemaPayload,
      CLI_JSON_RESULT_JSON_SCHEMA,
    );
    // The schema document obviously does not match the CliJsonResult
    // shape — this is the contract: don't pipe schema output through
    // a CliJsonResult validator.
    expect(r.ok).toBe(false);
  });

  it('a fresh getCliJsonSchema("cli-result") is recognised as JSON-Schema-shaped', () => {
    // Sanity meta-check: the schema document itself has $schema/$id.
    const schema = getCliJsonSchema('cli-result') as {
      $schema?: string;
      $id?: string;
    };
    expect(schema.$schema).toContain('json-schema.org');
    expect(schema.$id).toContain('cli-result');
  });
});

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@plccopilot/codegen-core';
import {
  GENERATE_SUMMARY_JSON_SCHEMA,
  cliSchemaFileName,
  getCliJsonSchema,
} from '../src/json-schema.js';
import { runGenerate } from '../src/commands/generate.js';
import { runSchema } from '../src/commands/schema.js';
import { main } from '../src/cli.js';
import { validateAgainstSchema } from './schema-validator.js';
import {
  bufferedIO,
  cleanupTmp,
  fixturePath,
  makeTmpDir,
} from './test-helpers.js';
import type { CliGenerateJsonResult } from '../src/json-output.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', 'schemas');

function readStaticSchemaFile(): unknown {
  const path = resolve(SCHEMAS_DIR, cliSchemaFileName('generate-summary'));
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function readSummary(out: string): unknown {
  return JSON.parse(readFileSync(resolve(out, 'summary.json'), 'utf-8'));
}

// =============================================================================
// Sprint 49 — schema constant + helper coverage
// =============================================================================

describe('GENERATE_SUMMARY_JSON_SCHEMA shape pin', () => {
  it('declares draft 2020-12 + canonical $id', () => {
    expect(GENERATE_SUMMARY_JSON_SCHEMA.$schema).toContain('draft/2020-12');
    expect(GENERATE_SUMMARY_JSON_SCHEMA.$id).toContain(
      'generate-summary.schema.json',
    );
  });

  it('uses oneOf to discriminate single-backend vs all-backends', () => {
    expect(GENERATE_SUMMARY_JSON_SCHEMA.oneOf).toHaveLength(2);
    expect(GENERATE_SUMMARY_JSON_SCHEMA.$defs.SingleBackendSummary).toBeDefined();
    expect(GENERATE_SUMMARY_JSON_SCHEMA.$defs.AllBackendsSummary).toBeDefined();
  });

  it('SingleBackendSummary requires backend + artifact_count + diagnostics + artifacts', () => {
    const def = GENERATE_SUMMARY_JSON_SCHEMA.$defs.SingleBackendSummary;
    expect(def.required).toEqual([
      'backend',
      'artifact_count',
      'diagnostics',
      'artifacts',
    ]);
    expect(def.additionalProperties).toBe(false);
    expect(def.properties.backend).toEqual({ $ref: '#/$defs/BackendId' });
  });

  it('AllBackendsSummary pins backend: "all" + nested runs[]', () => {
    const def = GENERATE_SUMMARY_JSON_SCHEMA.$defs.AllBackendsSummary;
    expect(def.required).toEqual(['backend', 'runs']);
    expect(def.properties.backend).toEqual({
      type: 'string',
      const: 'all',
    });
    expect(def.properties.runs).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/SingleBackendSummary' },
    });
  });
});

// =============================================================================
// Sprint 49 — schema subcommand surfaces the new schema
// =============================================================================

describe('schema subcommand — generate-summary', () => {
  it('runSchema({ name: "generate-summary" }) prints the static schema', async () => {
    const io = bufferedIO();
    const code = await runSchema({ name: 'generate-summary' }, io);
    expect(code).toBe(0);
    const printed = JSON.parse(io.out()) as { $id: string };
    expect(printed.$id).toContain('generate-summary');
    expect(io.out()).toBe(stableJson(getCliJsonSchema('generate-summary')));
  });

  it('main(["schema", "--name", "generate-summary"]) round-trips', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', '--name', 'generate-summary'],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out()) as { $id: string };
    expect(parsed.$id).toContain('generate-summary');
  });
});

// =============================================================================
// Sprint 49 — real summary.json validates against the schema
// =============================================================================

describe('real summary.json validates against generate-summary schema', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  function expectSummaryValidates(payload: unknown, hint = ''): void {
    // Use the in-tree static schema file as the source-of-truth target —
    // closes the loop "static file ↔ disk-written summary".
    const fileSchema = readStaticSchemaFile();
    const r = validateAgainstSchema(payload, fileSchema);
    if (!r.ok) {
      const detail = r.issues
        .slice(0, 8)
        .map((i) => `  - ${i.path}: ${i.message}`)
        .join('\n');
      throw new Error(
        `summary validation failed${hint ? ` (${hint})` : ''}:\n${detail}`,
      );
    }
  }

  it('siemens single-backend summary.json validates', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    expect(code).toBe(0);
    const summary = readSummary(tmp) as { backend: string };
    expect(summary.backend).toBe('siemens');
    expectSummaryValidates(summary, 'siemens');
  });

  it('codesys single-backend summary.json validates', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'codesys', out: tmp },
      io,
    );
    expect(code).toBe(0);
    const summary = readSummary(tmp) as { backend: string };
    expect(summary.backend).toBe('codesys');
    expectSummaryValidates(summary, 'codesys');
  });

  it('rockwell single-backend summary.json validates', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'rockwell', out: tmp },
      io,
    );
    expect(code).toBe(0);
    const summary = readSummary(tmp) as { backend: string };
    expect(summary.backend).toBe('rockwell');
    expectSummaryValidates(summary, 'rockwell');
  });

  it('all-backends summary.json validates and includes runs[]', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'all', out: tmp },
      io,
    );
    expect(code).toBe(0);
    const summary = readSummary(tmp) as {
      backend: string;
      runs: unknown[];
    };
    expect(summary.backend).toBe('all');
    expect(Array.isArray(summary.runs)).toBe(true);
    expect(summary.runs.length).toBe(3);
    expectSummaryValidates(summary, 'all');
  });

  // ---- Drift detectors: the validator MUST reject specific mutations ----

  it('rejects a single-backend summary with an unexpected property', async () => {
    const io = bufferedIO();
    await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    const baseline = readSummary(tmp) as Record<string, unknown>;
    const mutated = { ...baseline, unexpected: true };
    const r = validateAgainstSchema(mutated, readStaticSchemaFile());
    expect(r.ok).toBe(false);
  });

  it('rejects a summary with a decimal diagnostic count', async () => {
    const io = bufferedIO();
    await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    const baseline = readSummary(tmp) as {
      diagnostics: { errors: number; warnings: number; info: number };
    };
    const mutated = {
      ...baseline,
      diagnostics: { ...baseline.diagnostics, errors: 0.5 },
    };
    const r = validateAgainstSchema(mutated, readStaticSchemaFile());
    expect(r.ok).toBe(false);
  });

  it('rejects a summary with an unknown backend value', async () => {
    const io = bufferedIO();
    await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    const baseline = readSummary(tmp) as Record<string, unknown>;
    const mutated = { ...baseline, backend: 'mitsubishi' };
    const r = validateAgainstSchema(mutated, readStaticSchemaFile());
    expect(r.ok).toBe(false);
  });

  it('rejects a single-backend summary missing the `artifacts` array', async () => {
    const io = bufferedIO();
    await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    const baseline = readSummary(tmp) as Record<string, unknown>;
    const { artifacts: _drop, ...mutated } = baseline;
    const r = validateAgainstSchema(mutated, readStaticSchemaFile());
    expect(r.ok).toBe(false);
  });
});

// =============================================================================
// Sprint 49 — closes the loop CLI stdout JSON ↔ summary.json on disk
// =============================================================================

describe('cli-result.summary_path points at a generate-summary-valid file', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it("generate --json's summary_path resolves to a file that validates", async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp, json: true },
      io,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.out()) as CliGenerateJsonResult;
    expect(typeof payload.summary_path).toBe('string');
    expect(existsSync(payload.summary_path)).toBe(true);
    const summary = JSON.parse(
      readFileSync(payload.summary_path, 'utf-8'),
    );
    const r = validateAgainstSchema(summary, readStaticSchemaFile());
    expect(r.ok).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serializeCompilerError,
  stableJson,
} from '@plccopilot/codegen-core';
import {
  CLI_JSON_RESULT_JSON_SCHEMA,
  GENERATE_SUMMARY_JSON_SCHEMA,
  SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
  WEB_ZIP_SUMMARY_JSON_SCHEMA,
  cliSchemaFileName,
  getCliJsonSchema,
  getCliJsonSchemaEntries,
  listCliSchemaNames,
  type CliSchemaName,
} from '../src/json-schema.js';
import {
  buildErrorPayload,
  buildGeneratePayload,
  buildInspectPayload,
  buildValidatePayload,
} from '../src/json-output.js';
import { validateAgainstSchema } from './schema-validator.js';
import { fixturePath } from './test-helpers.js';
import { validate as validatePir } from '@plccopilot/pir';
import type { Project } from '@plccopilot/pir';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', 'schemas');

function readSchemaFile(name: CliSchemaName): string {
  const path = resolve(SCHEMAS_DIR, cliSchemaFileName(name));
  return readFileSync(path, 'utf-8');
}

function loadProject(): Project {
  return JSON.parse(readFileSync(fixturePath(), 'utf-8')) as Project;
}

// =============================================================================
// Sprint 48 — helper exports
// =============================================================================

describe('schema file helpers', () => {
  it('cliSchemaFileName returns canonical filenames', () => {
    expect(cliSchemaFileName('cli-result')).toBe('cli-result.schema.json');
    expect(cliSchemaFileName('serialized-compiler-error')).toBe(
      'serialized-compiler-error.schema.json',
    );
  });

  it('getCliJsonSchemaEntries enumerates every published schema', () => {
    const entries = getCliJsonSchemaEntries();
    expect(entries.map((e) => e.name)).toEqual([
      'cli-result',
      'serialized-compiler-error',
      'generate-summary',
      'web-zip-summary',
    ]);
    for (const e of entries) {
      expect(e.fileName.endsWith('.schema.json')).toBe(true);
      expect(typeof e.schema).toBe('object');
    }
  });

  it('getCliJsonSchemaEntries returns deep-cloned schemas (mutation does not leak)', () => {
    const a = getCliJsonSchemaEntries();
    (a[0]!.schema as { title: string }).title = 'mutated';
    const b = getCliJsonSchemaEntries();
    expect((b[0]!.schema as { title: string }).title).toBe(
      'PLC Copilot CLI JSON Result',
    );
  });
});

// =============================================================================
// Sprint 48 — static files exist + parse
// =============================================================================

describe('static schema files exist and parse', () => {
  it.each(listCliSchemaNames())('%s file exists and is valid JSON', (name) => {
    const path = resolve(SCHEMAS_DIR, cliSchemaFileName(name));
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('cli-result.schema.json declares the correct $id', () => {
    const parsed = JSON.parse(readSchemaFile('cli-result')) as {
      $id: string;
    };
    expect(parsed.$id).toBe(
      'https://plccopilot.dev/schemas/cli-result.schema.json',
    );
  });

  it('serialized-compiler-error.schema.json declares the correct $id', () => {
    const parsed = JSON.parse(readSchemaFile('serialized-compiler-error')) as {
      $id: string;
    };
    expect(parsed.$id).toBe(
      'https://plccopilot.dev/schemas/serialized-compiler-error.schema.json',
    );
  });

  it('generate-summary.schema.json declares the correct $id', () => {
    const parsed = JSON.parse(readSchemaFile('generate-summary')) as {
      $id: string;
    };
    expect(parsed.$id).toBe(
      'https://plccopilot.dev/schemas/generate-summary.schema.json',
    );
  });

  it('web-zip-summary.schema.json declares the correct $id', () => {
    const parsed = JSON.parse(readSchemaFile('web-zip-summary')) as {
      $id: string;
    };
    expect(parsed.$id).toBe(
      'https://plccopilot.dev/schemas/web-zip-summary.schema.json',
    );
  });

  it('both files declare draft 2020-12 as $schema', () => {
    for (const name of listCliSchemaNames()) {
      const parsed = JSON.parse(readSchemaFile(name)) as { $schema: string };
      expect(parsed.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
    }
  });
});

// =============================================================================
// Sprint 48 — drift detection: file content === stableJson(constant)
// =============================================================================

describe('static schema files are byte-equivalent to the TS constants', () => {
  it('cli-result.schema.json matches stableJson(CLI_JSON_RESULT_JSON_SCHEMA)', () => {
    expect(readSchemaFile('cli-result')).toBe(
      stableJson(CLI_JSON_RESULT_JSON_SCHEMA),
    );
  });

  it('serialized-compiler-error.schema.json matches stableJson(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA)', () => {
    expect(readSchemaFile('serialized-compiler-error')).toBe(
      stableJson(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA),
    );
  });

  it('generate-summary.schema.json matches stableJson(GENERATE_SUMMARY_JSON_SCHEMA)', () => {
    expect(readSchemaFile('generate-summary')).toBe(
      stableJson(GENERATE_SUMMARY_JSON_SCHEMA),
    );
  });

  it('web-zip-summary.schema.json matches stableJson(WEB_ZIP_SUMMARY_JSON_SCHEMA)', () => {
    expect(readSchemaFile('web-zip-summary')).toBe(
      stableJson(WEB_ZIP_SUMMARY_JSON_SCHEMA),
    );
  });

  it.each(listCliSchemaNames())(
    '%s file deep-equals getCliJsonSchema()',
    (name) => {
      const parsed = JSON.parse(readSchemaFile(name));
      expect(parsed).toEqual(getCliJsonSchema(name));
    },
  );

  it('mutating the parsed file does not poison getCliJsonSchema', () => {
    const parsed = JSON.parse(readSchemaFile('cli-result')) as {
      title: string;
    };
    parsed.title = 'mutated';
    const fresh = getCliJsonSchema('cli-result') as { title: string };
    expect(fresh.title).toBe('PLC Copilot CLI JSON Result');
  });
});

// =============================================================================
// Sprint 48 — static files validate the same payloads as the TS constants
// =============================================================================

describe('static schema files behave the same as the TS constants', () => {
  it('static cli-result.schema.json validates buildGeneratePayload', () => {
    const fileSchema = JSON.parse(readSchemaFile('cli-result'));
    const payload = buildGeneratePayload({
      backend: 'siemens',
      outDir: '/abs/out',
      artifactCount: 1,
      writtenFiles: ['/abs/out/x.scl'],
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      summaryPath: '/abs/out/summary.json',
    });
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(true);
  });

  it('static cli-result.schema.json validates buildValidatePayload', () => {
    const fileSchema = JSON.parse(readSchemaFile('cli-result'));
    const project = loadProject();
    const payload = buildValidatePayload(project, validatePir(project));
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(true);
  });

  it('static cli-result.schema.json validates buildInspectPayload', () => {
    const fileSchema = JSON.parse(readSchemaFile('cli-result'));
    const payload = buildInspectPayload(loadProject());
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(true);
  });

  it('static cli-result.schema.json validates buildErrorPayload', () => {
    const fileSchema = JSON.parse(readSchemaFile('cli-result'));
    const payload = buildErrorPayload('generate', new Error('boom'));
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(true);
  });

  it('static serialized-compiler-error.schema.json validates serializeCompilerError output', () => {
    const fileSchema = JSON.parse(readSchemaFile('serialized-compiler-error'));
    const payload = serializeCompilerError(new Error('plain'));
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(true);
  });

  it('static cli-result.schema.json rejects an unexpected property (additionalProperties: false survives the round-trip)', () => {
    const fileSchema = JSON.parse(readSchemaFile('cli-result'));
    const baseline = buildGeneratePayload({
      backend: 'siemens',
      outDir: '/o',
      artifactCount: 0,
      writtenFiles: [],
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      summaryPath: '/o/summary.json',
    });
    const mutated = { ...baseline, unexpected: true };
    expect(validateAgainstSchema(mutated, fileSchema).ok).toBe(false);
  });
});

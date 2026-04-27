import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@plccopilot/codegen-core';
import {
  WEB_ZIP_SUMMARY_JSON_SCHEMA,
  cliSchemaFileName,
  getCliJsonSchema,
} from '../src/json-schema.js';
import { runSchema } from '../src/commands/schema.js';
import { main } from '../src/cli.js';
import { validateAgainstSchema } from './schema-validator.js';
import { bufferedIO } from './test-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', 'schemas');

function readStaticSchemaFile(): unknown {
  const path = resolve(SCHEMAS_DIR, cliSchemaFileName('web-zip-summary'));
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const FIXED_TS = '2026-04-26T10:00:00.000Z';

function validSiemensSummary(): Record<string, unknown> {
  return {
    backend: 'siemens',
    artifactCount: 9,
    errors: 0,
    warnings: 1,
    info: 2,
    generated_at: FIXED_TS,
  };
}

function validAllSummary(): Record<string, unknown> {
  return {
    backend: 'all',
    artifactCount: 27,
    errors: 0,
    warnings: 3,
    info: 6,
    generated_at: FIXED_TS,
  };
}

// =============================================================================
// Sprint 51 — schema constant shape pin
// =============================================================================

describe('WEB_ZIP_SUMMARY_JSON_SCHEMA basic shape', () => {
  it('declares draft 2020-12 + canonical $id + title', () => {
    expect(WEB_ZIP_SUMMARY_JSON_SCHEMA.$schema).toContain('draft/2020-12');
    expect(WEB_ZIP_SUMMARY_JSON_SCHEMA.$id).toContain(
      'web-zip-summary.schema.json',
    );
    expect(WEB_ZIP_SUMMARY_JSON_SCHEMA.title).toContain(
      'PLC Copilot Web ZIP Summary',
    );
  });

  it('locks the FLAT shape: required field set + additionalProperties:false', () => {
    expect(WEB_ZIP_SUMMARY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(WEB_ZIP_SUMMARY_JSON_SCHEMA.required).toEqual([
      'backend',
      'artifactCount',
      'errors',
      'warnings',
      'info',
      'generated_at',
    ]);
    expect(WEB_ZIP_SUMMARY_JSON_SCHEMA.properties.backend.enum).toEqual([
      'siemens',
      'codesys',
      'rockwell',
      'all',
    ]);
  });
});

// =============================================================================
// Sprint 51 — accepted payloads
// =============================================================================

describe('web-zip-summary schema validates real Web ZIP payloads', () => {
  const fileSchema = readStaticSchemaFile();

  it('accepts a valid siemens summary', () => {
    expect(validateAgainstSchema(validSiemensSummary(), fileSchema).ok).toBe(
      true,
    );
  });

  it('accepts a valid "all" summary', () => {
    expect(validateAgainstSchema(validAllSummary(), fileSchema).ok).toBe(true);
  });

  it.each(['siemens', 'codesys', 'rockwell', 'all'] as const)(
    'accepts backend "%s"',
    (backend) => {
      const payload = { ...validSiemensSummary(), backend };
      expect(validateAgainstSchema(payload, fileSchema).ok).toBe(true);
    },
  );
});

// =============================================================================
// Sprint 51 — rejected payloads
// =============================================================================

describe('web-zip-summary schema rejects invalid payloads', () => {
  const fileSchema = readStaticSchemaFile();

  it('rejects an unknown backend value', () => {
    const payload = { ...validSiemensSummary(), backend: 'mitsubishi' };
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });

  it('rejects missing generated_at', () => {
    const { generated_at: _drop, ...payload } = validSiemensSummary();
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });

  it('rejects an invalid generated_at format', () => {
    const payload = {
      ...validSiemensSummary(),
      generated_at: 'not-a-date-at-all',
    };
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });

  it('rejects a decimal artifactCount', () => {
    const payload = { ...validSiemensSummary(), artifactCount: 1.5 };
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });

  it('rejects negative diagnostic counts', () => {
    const payload = { ...validSiemensSummary(), warnings: -1 };
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });

  it('rejects an additional property', () => {
    const payload = { ...validSiemensSummary(), extra_field: true };
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });

  it('rejects nested diagnostics shape (legacy FLAT contract)', () => {
    const payload = {
      backend: 'siemens',
      artifactCount: 1,
      generated_at: FIXED_TS,
      diagnostics: { errors: 0, warnings: 0, info: 0 },
    };
    expect(validateAgainstSchema(payload, fileSchema).ok).toBe(false);
  });
});

// =============================================================================
// Sprint 51 — schema subcommand surfaces the new schema
// =============================================================================

describe('schema subcommand — web-zip-summary', () => {
  it('runSchema({ name: "web-zip-summary" }) prints the static schema', async () => {
    const io = bufferedIO();
    const code = await runSchema({ name: 'web-zip-summary' }, io);
    expect(code).toBe(0);
    expect(io.out()).toBe(stableJson(getCliJsonSchema('web-zip-summary')));
  });

  it('main(["schema", "--name", "web-zip-summary"]) prints the schema', async () => {
    const io = bufferedIO();
    const code = await main(['schema', '--name', 'web-zip-summary'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out()) as { $id: string };
    expect(parsed.$id).toContain('web-zip-summary');
  });

  it('schema subcommand output validates the same valid payload', async () => {
    const io = bufferedIO();
    await runSchema({ name: 'web-zip-summary' }, io);
    const printed = JSON.parse(io.out());
    expect(
      validateAgainstSchema(validSiemensSummary(), printed).ok,
    ).toBe(true);
  });

  it('static file equals stableJson(constant) AND validates the payload', () => {
    const fileText = readFileSync(
      resolve(SCHEMAS_DIR, cliSchemaFileName('web-zip-summary')),
      'utf-8',
    );
    expect(fileText).toBe(stableJson(getCliJsonSchema('web-zip-summary')));
    const fileSchema = JSON.parse(fileText);
    expect(
      validateAgainstSchema(validSiemensSummary(), fileSchema).ok,
    ).toBe(true);
  });
});

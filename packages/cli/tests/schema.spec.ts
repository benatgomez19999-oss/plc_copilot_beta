import { describe, expect, it } from 'vitest';
import { runSchema } from '../src/commands/schema.js';
import { main } from '../src/cli.js';
import {
  CLI_JSON_RESULT_JSON_SCHEMA,
  CLI_JSON_SCHEMA_VERSION,
  SERIALIZED_COMPILER_ERROR_JSON_SCHEMA,
  getCliJsonSchema,
  isCliSchemaName,
  listCliSchemaNames,
} from '../src/json-schema.js';
import { bufferedIO } from './test-helpers.js';

// =============================================================================
// Sprint 46 — pure schema-module unit tests
// =============================================================================

describe('json-schema — name index', () => {
  it('listCliSchemaNames returns the stable, ordered set', () => {
    expect(listCliSchemaNames()).toEqual([
      'cli-result',
      'serialized-compiler-error',
      'generate-summary',
      'web-zip-summary',
    ]);
  });

  it('isCliSchemaName accepts known names + rejects others', () => {
    expect(isCliSchemaName('cli-result')).toBe(true);
    expect(isCliSchemaName('serialized-compiler-error')).toBe(true);
    expect(isCliSchemaName('generate-summary')).toBe(true);
    expect(isCliSchemaName('web-zip-summary')).toBe(true);
    expect(isCliSchemaName('bad')).toBe(false);
    expect(isCliSchemaName('')).toBe(false);
    expect(isCliSchemaName('CLI-RESULT')).toBe(false);
  });

  it('CLI_JSON_SCHEMA_VERSION is 1 (sprint 46 baseline)', () => {
    expect(CLI_JSON_SCHEMA_VERSION).toBe(1);
  });
});

describe('json-schema — cli-result schema shape', () => {
  it('exposes $schema, $id, oneOf and $defs', () => {
    expect(CLI_JSON_RESULT_JSON_SCHEMA.$schema).toContain('json-schema.org');
    expect(CLI_JSON_RESULT_JSON_SCHEMA.$id).toContain('cli-result');
    expect(Array.isArray(CLI_JSON_RESULT_JSON_SCHEMA.oneOf)).toBe(true);
    expect(CLI_JSON_RESULT_JSON_SCHEMA.oneOf).toHaveLength(4);
    expect(CLI_JSON_RESULT_JSON_SCHEMA.$defs).toBeDefined();
  });

  it('$defs.SerializedCompilerError requires name + message', () => {
    const def = CLI_JSON_RESULT_JSON_SCHEMA.$defs.SerializedCompilerError;
    expect(def.required).toEqual(['name', 'message']);
    expect(def.properties.code).toBeDefined();
    expect(def.properties.path).toBeDefined();
    expect(def.properties.stack).toBeDefined();
    expect(def.additionalProperties).toBe(false);
  });

  it('CliGenerateJsonResult pins ok=true and command="generate"', () => {
    const def = CLI_JSON_RESULT_JSON_SCHEMA.$defs.CliGenerateJsonResult;
    expect(def.properties.ok).toEqual({ type: 'boolean', const: true });
    expect(def.properties.command).toEqual({
      type: 'string',
      const: 'generate',
    });
    expect(def.required).toContain('written_files');
    expect(def.required).toContain('summary_path');
    expect(def.required).toContain('artifact_count');
  });

  it('CliValidateJsonResult allows ok: boolean (true OR false report)', () => {
    const def = CLI_JSON_RESULT_JSON_SCHEMA.$defs.CliValidateJsonResult;
    expect(def.properties.ok).toEqual({ type: 'boolean' });
    expect(def.properties.command).toEqual({
      type: 'string',
      const: 'validate',
    });
    expect(def.required).toContain('issues');
    expect(def.required).toContain('counts');
  });

  it('CliInspectJsonResult requires supported_backends + project + counts', () => {
    const def = CLI_JSON_RESULT_JSON_SCHEMA.$defs.CliInspectJsonResult;
    expect(def.required).toContain('supported_backends');
    expect(def.required).toContain('project');
    expect(def.required).toContain('counts');
    expect(def.required).toContain('machines');
    expect(def.properties.ok).toEqual({ type: 'boolean', const: true });
    expect(def.properties.command).toEqual({
      type: 'string',
      const: 'inspect',
    });
  });

  it('CliJsonErrorResult references SerializedCompilerError via $ref', () => {
    const def = CLI_JSON_RESULT_JSON_SCHEMA.$defs.CliJsonErrorResult;
    expect(def.properties.ok).toEqual({ type: 'boolean', const: false });
    expect(def.properties.error).toEqual({
      $ref: '#/$defs/SerializedCompilerError',
    });
  });

  it('DiagnosticsCounts uses integer >= 0', () => {
    const counts = CLI_JSON_RESULT_JSON_SCHEMA.$defs.DiagnosticsCounts;
    expect(counts.properties.errors).toEqual({
      type: 'integer',
      minimum: 0,
    });
    expect(counts.required).toEqual(['errors', 'warnings', 'info']);
  });
});

describe('json-schema — serialized-compiler-error schema shape', () => {
  it('mirrors the $defs counterpart', () => {
    expect(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA.required).toEqual([
      'name',
      'message',
    ]);
    expect(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA.additionalProperties).toBe(
      false,
    );
    expect(
      SERIALIZED_COMPILER_ERROR_JSON_SCHEMA.properties.stack,
    ).toBeDefined();
  });

  it('uses draft 2020-12', () => {
    expect(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA.$schema).toContain(
      'draft/2020-12',
    );
  });
});

describe('getCliJsonSchema — deep-clone semantics', () => {
  it('returns a deep clone (subsequent mutation does not leak)', () => {
    const a = getCliJsonSchema('cli-result') as { title: string };
    a.title = 'mutated';
    const b = getCliJsonSchema('cli-result') as { title: string };
    expect(b.title).toBe('PLC Copilot CLI JSON Result');
  });

  it('the live constants are not mutated by previous getters', () => {
    getCliJsonSchema('cli-result');
    getCliJsonSchema('serialized-compiler-error');
    expect(CLI_JSON_RESULT_JSON_SCHEMA.title).toBe(
      'PLC Copilot CLI JSON Result',
    );
    expect(SERIALIZED_COMPILER_ERROR_JSON_SCHEMA.title).toBe(
      'PLC Copilot Serialized Compiler Error',
    );
  });
});

// =============================================================================
// runSchema — direct invocation
// =============================================================================

function parseOutput(io: ReturnType<typeof bufferedIO>): unknown {
  return JSON.parse(io.out());
}

describe('runSchema — direct invocation', () => {
  it('default (no --name) prints cli-result with title "PLC Copilot CLI JSON Result"', async () => {
    const io = bufferedIO();
    const code = await runSchema({}, io);
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    const schema = parseOutput(io) as { title: string };
    expect(schema.title).toBe('PLC Copilot CLI JSON Result');
  });

  it('--name cli-result matches the default output', async () => {
    const a = bufferedIO();
    const b = bufferedIO();
    await runSchema({}, a);
    await runSchema({ name: 'cli-result' }, b);
    expect(a.out()).toBe(b.out());
  });

  it('--name serialized-compiler-error prints the error envelope schema', async () => {
    const io = bufferedIO();
    const code = await runSchema(
      { name: 'serialized-compiler-error' },
      io,
    );
    expect(code).toBe(0);
    const schema = parseOutput(io) as {
      title: string;
      required: string[];
    };
    expect(schema.title).toBe('PLC Copilot Serialized Compiler Error');
    expect(schema.required).toEqual(['name', 'message']);
  });

  it('--name unknown exits 1 with a human-readable stderr line, no stdout', async () => {
    const io = bufferedIO();
    const code = await runSchema({ name: 'totally-unknown' }, io);
    expect(code).toBe(1);
    expect(io.out()).toBe('');
    expect(io.err()).toMatch(/unknown schema/);
    expect(io.err()).toMatch(/cli-result/);
  });
});

// =============================================================================
// Dispatcher E2E — main()
// =============================================================================

describe('main() — schema subcommand', () => {
  it('main(["schema"]) exits 0 with parseable JSON Schema on stdout', async () => {
    const io = bufferedIO();
    const code = await main(['schema'], io);
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    const schema = JSON.parse(io.out()) as { $id: string };
    expect(schema.$id).toContain('cli-result');
  });

  it('main(["schema", "--name", "serialized-compiler-error"]) prints the error schema', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', '--name', 'serialized-compiler-error'],
      io,
    );
    expect(code).toBe(0);
    const schema = JSON.parse(io.out()) as { $id: string };
    expect(schema.$id).toContain('serialized-compiler-error');
  });

  it('main(["schema", "--name=cli-result"]) accepts the equals form', async () => {
    const io = bufferedIO();
    const code = await main(['schema', '--name=cli-result'], io);
    expect(code).toBe(0);
    const schema = JSON.parse(io.out()) as { $id: string };
    expect(schema.$id).toContain('cli-result');
  });

  it('main(["help"]) advertises the new schema subcommand', async () => {
    const io = bufferedIO();
    const code = await main(['help'], io);
    expect(code).toBe(0);
    expect(io.out()).toMatch(/schema\s+Print JSON Schema/);
    expect(io.out()).toMatch(/--name/);
  });
});

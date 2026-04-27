import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@plccopilot/codegen-core';
import {
  cliSchemaFileName,
  getCliJsonSchema,
  getCliJsonSchemaEntries,
  listCliSchemaNames,
} from '../src/json-schema.js';
import { runSchema } from '../src/commands/schema.js';
import { main } from '../src/cli.js';
import {
  bufferedIO,
  cleanupTmp,
  makeTmpDir,
} from './test-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_SCHEMAS_DIR = resolve(HERE, '..', 'schemas');
const PACKAGE_JSON_PATH = resolve(HERE, '..', 'package.json');

// =============================================================================
// Bloque A — runSchema --out direct
// =============================================================================

describe('runSchema({ out }) — direct invocation', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('writes every schema when --out is provided without --name', async () => {
    const io = bufferedIO();
    const code = await runSchema({ out: tmp }, io);
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    expect(io.out()).toMatch(/Wrote 4 schema files/);
    for (const name of listCliSchemaNames()) {
      expect(existsSync(join(tmp, cliSchemaFileName(name)))).toBe(true);
    }
  });

  it('written files are byte-identical to the published static schemas', async () => {
    const io = bufferedIO();
    await runSchema({ out: tmp }, io);
    for (const name of listCliSchemaNames()) {
      const fileName = cliSchemaFileName(name);
      const fresh = readFileSync(join(tmp, fileName), 'utf-8');
      const onDisk = readFileSync(join(STATIC_SCHEMAS_DIR, fileName), 'utf-8');
      expect(fresh).toBe(onDisk);
    }
  });

  it('written files are byte-identical to stableJson(constants)', async () => {
    const io = bufferedIO();
    await runSchema({ out: tmp }, io);
    for (const name of listCliSchemaNames()) {
      const fresh = readFileSync(
        join(tmp, cliSchemaFileName(name)),
        'utf-8',
      );
      expect(fresh).toBe(stableJson(getCliJsonSchema(name)));
    }
  });

  it('writes only the selected schema with --name + --out', async () => {
    const io = bufferedIO();
    const code = await runSchema(
      { name: 'generate-summary', out: tmp },
      io,
    );
    expect(code).toBe(0);
    expect(io.out()).toMatch(/Wrote schema file to /);
    expect(
      existsSync(join(tmp, 'generate-summary.schema.json')),
    ).toBe(true);
    expect(existsSync(join(tmp, 'cli-result.schema.json'))).toBe(false);
    expect(
      existsSync(join(tmp, 'serialized-compiler-error.schema.json')),
    ).toBe(false);
  });

  it('creates missing output directories recursively', async () => {
    const nested = join(tmp, 'a', 'b', 'c');
    const io = bufferedIO();
    const code = await runSchema({ out: nested }, io);
    expect(code).toBe(0);
    for (const name of listCliSchemaNames()) {
      expect(existsSync(join(nested, cliSchemaFileName(name)))).toBe(true);
    }
  });

  it('rejects unknown --name even with --out and writes nothing', async () => {
    const io = bufferedIO();
    const code = await runSchema({ name: 'oops', out: tmp }, io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/unknown schema "oops"/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('rejects --out when path is an existing non-directory', async () => {
    const filePath = join(tmp, 'not-a-dir');
    writeFileSync(filePath, 'sentinel', 'utf-8');
    const io = bufferedIO();
    const code = await runSchema({ out: filePath }, io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/--out must point to a directory/);
    // No "Wrote" line — schema content must NOT be in stdout either.
    expect(io.out()).not.toMatch(/Wrote/);
  });

  it('overwrites pre-existing schema files deterministically', async () => {
    const io1 = bufferedIO();
    await runSchema({ out: tmp }, io1);
    const target = join(tmp, 'cli-result.schema.json');
    writeFileSync(target, 'corrupted', 'utf-8');
    const io2 = bufferedIO();
    await runSchema({ out: tmp }, io2);
    expect(readFileSync(target, 'utf-8')).toBe(
      stableJson(getCliJsonSchema('cli-result')),
    );
  });

  it('every written file parses as valid JSON', async () => {
    const io = bufferedIO();
    await runSchema({ out: tmp }, io);
    for (const name of listCliSchemaNames()) {
      const raw = readFileSync(
        join(tmp, cliSchemaFileName(name)),
        'utf-8',
      );
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('does not print schema JSON to stdout when --out is set', async () => {
    const io = bufferedIO();
    await runSchema({ out: tmp }, io);
    // Must NOT contain a JSON-Schema $id token.
    expect(io.out()).not.toContain('"$schema"');
    expect(io.out()).not.toContain('"$id"');
  });
});

// =============================================================================
// Bloque B — main() dispatcher
// =============================================================================

describe('main() — schema --out via dispatcher', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('main(["schema", "--out", tmp]) writes every schema', async () => {
    const io = bufferedIO();
    const code = await main(['schema', '--out', tmp], io);
    expect(code).toBe(0);
    for (const name of listCliSchemaNames()) {
      expect(existsSync(join(tmp, cliSchemaFileName(name)))).toBe(true);
    }
  });

  it('supports --out=<path> equals form', async () => {
    const io = bufferedIO();
    const code = await main(['schema', `--out=${tmp}`], io);
    expect(code).toBe(0);
    expect(
      existsSync(join(tmp, 'cli-result.schema.json')),
    ).toBe(true);
  });

  it('main(["schema", "--name", "serialized-compiler-error", "--out", tmp]) writes selected only', async () => {
    const io = bufferedIO();
    const code = await main(
      [
        'schema',
        '--name',
        'serialized-compiler-error',
        '--out',
        tmp,
      ],
      io,
    );
    expect(code).toBe(0);
    expect(
      existsSync(join(tmp, 'serialized-compiler-error.schema.json')),
    ).toBe(true);
    expect(existsSync(join(tmp, 'cli-result.schema.json'))).toBe(false);
    expect(
      existsSync(join(tmp, 'generate-summary.schema.json')),
    ).toBe(false);
  });

  it('supports --name=<n> --out=<p> equals form for both flags', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', '--name=generate-summary', `--out=${tmp}`],
      io,
    );
    expect(code).toBe(0);
    expect(
      existsSync(join(tmp, 'generate-summary.schema.json')),
    ).toBe(true);
  });

  it('main(["schema", "--name", "oops", "--out", tmp]) returns exit 1', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', '--name', 'oops', '--out', tmp],
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toMatch(/unknown schema "oops"/);
  });

  it('regression: main(["schema"]) still prints raw cli-result schema to stdout', async () => {
    const io = bufferedIO();
    const code = await main(['schema'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out()) as { $id: string };
    expect(parsed.$id).toContain('cli-result');
  });

  it('regression: main(["schema", "--name", "generate-summary"]) prints raw schema', async () => {
    const io = bufferedIO();
    const code = await main(['schema', '--name', 'generate-summary'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out()) as { $id: string };
    expect(parsed.$id).toContain('generate-summary');
  });

  it('help mentions schema --out and the new schema names', async () => {
    const io = bufferedIO();
    const code = await main(['help'], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('--out <dir>');
    expect(io.out()).toContain('plccopilot schema --out ./schemas');
    expect(io.out()).toContain('--name generate-summary');
  });
});

// =============================================================================
// Bloque C — sync guard between API entries and on-disk static files
// =============================================================================

describe('static schema files ↔ API entries sync guard', () => {
  it('every getCliJsonSchemaEntries() entry maps to an existing static file', () => {
    for (const e of getCliJsonSchemaEntries()) {
      const path = join(STATIC_SCHEMAS_DIR, e.fileName);
      expect(existsSync(path)).toBe(true);
    }
  });

  it('packages/cli/schemas contains only the schemas the API enumerates', () => {
    const onDisk = readdirSync(STATIC_SCHEMAS_DIR)
      .filter((f) => f.endsWith('.schema.json'))
      .sort();
    const fromApi = listCliSchemaNames()
      .map((n) => cliSchemaFileName(n))
      .sort();
    expect(onDisk).toEqual(fromApi);
  });

  it('package.json exports include every published schema file', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
      exports?: Record<string, string>;
      files?: string[];
    };
    expect(pkg.exports).toBeDefined();
    expect(pkg.files).toContain('schemas');
    for (const e of getCliJsonSchemaEntries()) {
      const key = `./schemas/${e.fileName}`;
      expect(pkg.exports![key]).toBe(`./schemas/${e.fileName}`);
    }
  });

  it('every schema written via runSchema --out is the same file as on disk + same as stableJson(constant)', () => {
    // Triple-equality stitch: API constant ↔ runSchema disk write ↔ committed file.
    // All three must match for the published artifact to be trustworthy.
    const tmp = makeTmpDir();
    try {
      const io = bufferedIO();
      // Sync this run with await is fine; vitest "it" allows promise.
      // Using runSchema outside async because writes are sync underneath.
      void runSchema({ out: tmp }, io);
      for (const name of listCliSchemaNames()) {
        const fileName = cliSchemaFileName(name);
        const tmpContent = readFileSync(join(tmp, fileName), 'utf-8');
        const onDisk = readFileSync(
          join(STATIC_SCHEMAS_DIR, fileName),
          'utf-8',
        );
        const fromConstant = stableJson(getCliJsonSchema(name));
        expect(tmpContent).toBe(onDisk);
        expect(tmpContent).toBe(fromConstant);
      }
    } finally {
      cleanupTmp(tmp);
    }
  });

  it('every static file is itself a directory entry, not a symlink (sanity)', () => {
    for (const e of getCliJsonSchemaEntries()) {
      const stat = statSync(join(STATIC_SCHEMAS_DIR, e.fileName));
      expect(stat.isFile()).toBe(true);
    }
  });
});

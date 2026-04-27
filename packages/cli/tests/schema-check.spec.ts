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
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableJson } from '@plccopilot/codegen-core';
import {
  cliSchemaFileName,
  getCliJsonSchema,
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

function writeAllExpected(dir: string): void {
  for (const name of listCliSchemaNames()) {
    writeFileSync(
      join(dir, cliSchemaFileName(name)),
      stableJson(getCliJsonSchema(name)),
      'utf-8',
    );
  }
}

// =============================================================================
// A — runSchema --check success on the committed snapshot
// =============================================================================

describe('runSchema --check — committed schemas dir is in sync', () => {
  it('check all passes against packages/cli/schemas', async () => {
    const io = bufferedIO();
    const code = await runSchema({ check: STATIC_SCHEMAS_DIR }, io);
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    expect(io.out()).toContain('Schema files are in sync');
    expect(io.out()).toContain(STATIC_SCHEMAS_DIR);
  });

  it.each(listCliSchemaNames())(
    'selective --name %s --check passes against committed dir',
    async (name) => {
      const io = bufferedIO();
      const code = await runSchema(
        { name, check: STATIC_SCHEMAS_DIR },
        io,
      );
      expect(code).toBe(0);
      expect(io.err()).toBe('');
      expect(io.out()).toContain('Schema file is in sync');
      expect(io.out()).toContain(cliSchemaFileName(name));
    },
  );
});

// =============================================================================
// B — temp directory positive paths
// =============================================================================

describe('runSchema --check — fresh tmp directories', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('check all passes after writing every expected file', async () => {
    writeAllExpected(tmp);
    const io = bufferedIO();
    const code = await runSchema({ check: tmp }, io);
    expect(code).toBe(0);
    expect(io.out()).toContain('in sync');
  });

  it('selective check passes when only that one file exists', async () => {
    writeFileSync(
      join(tmp, 'cli-result.schema.json'),
      stableJson(getCliJsonSchema('cli-result')),
      'utf-8',
    );
    const io = bufferedIO();
    const code = await runSchema(
      { name: 'cli-result', check: tmp },
      io,
    );
    expect(code).toBe(0);
  });

  it('check all fails on an EXTRA file', async () => {
    writeAllExpected(tmp);
    writeFileSync(join(tmp, 'old.schema.json'), '{}', 'utf-8');
    const io = bufferedIO();
    const code = await runSchema({ check: tmp }, io);
    expect(code).toBe(1);
    expect(io.err()).toContain('unexpected: old.schema.json');
  });

  it('selective check IGNORES extra siblings', async () => {
    writeAllExpected(tmp);
    writeFileSync(join(tmp, 'old.schema.json'), '{}', 'utf-8');
    const io = bufferedIO();
    const code = await runSchema(
      { name: 'cli-result', check: tmp },
      io,
    );
    expect(code).toBe(0);
  });
});

// =============================================================================
// C — failure cases
// =============================================================================

describe('runSchema --check — failure cases', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('reports a missing file in all-mode and exits 1', async () => {
    writeAllExpected(tmp);
    const removed = join(tmp, 'web-zip-summary.schema.json');
    // Replace the populate with delete-after by simply unlink-equivalent
    // — the file was written by writeAllExpected. Use rm via fs.rmSync:
    // node 20 has rmSync. Inline import would be heavy; instead just
    // overwrite-then-remove via writeAllExpected without that name.
    // Simpler: rewrite directory without the target.
    writeFileSync(removed, '', 'utf-8');
    // Actually, simplest path: drop the file via fs.rmSync. Using inline import.
    const { rmSync } = await import('node:fs');
    rmSync(removed);
    const io = bufferedIO();
    const code = await runSchema({ check: tmp }, io);
    expect(code).toBe(1);
    expect(io.err()).toContain('missing: web-zip-summary.schema.json');
    expect(io.out()).toBe('');
  });

  it('reports a CHANGED file in all-mode and exits 1', async () => {
    writeAllExpected(tmp);
    writeFileSync(
      join(tmp, 'cli-result.schema.json'),
      'corrupted-content',
      'utf-8',
    );
    const io = bufferedIO();
    const code = await runSchema({ check: tmp }, io);
    expect(code).toBe(1);
    expect(io.err()).toContain('changed: cli-result.schema.json');
  });

  it('orders mixed issues missing → changed → unexpected', async () => {
    writeAllExpected(tmp);
    // Create a changed file, drop a file (missing), and add an extra.
    writeFileSync(
      join(tmp, 'cli-result.schema.json'),
      'corrupted',
      'utf-8',
    );
    const { rmSync } = await import('node:fs');
    rmSync(join(tmp, 'web-zip-summary.schema.json'));
    writeFileSync(join(tmp, 'old.schema.json'), '{}', 'utf-8');

    const io = bufferedIO();
    const code = await runSchema({ check: tmp }, io);
    expect(code).toBe(1);
    const stderr = io.err();
    const missingIdx = stderr.indexOf('missing: ');
    const changedIdx = stderr.indexOf('changed: ');
    const unexpectedIdx = stderr.indexOf('unexpected: ');
    expect(missingIdx).toBeGreaterThan(-1);
    expect(changedIdx).toBeGreaterThan(-1);
    expect(unexpectedIdx).toBeGreaterThan(-1);
    expect(missingIdx).toBeLessThan(changedIdx);
    expect(changedIdx).toBeLessThan(unexpectedIdx);
  });

  it('rejects --check pointing at a non-existent path', async () => {
    const ghost = join(tmp, 'nope', 'gone');
    const io = bufferedIO();
    const code = await runSchema({ check: ghost }, io);
    expect(code).toBe(1);
    expect(io.err()).toContain(
      '--check must point to an existing directory',
    );
  });

  it('rejects --check pointing at a file', async () => {
    const filePath = join(tmp, 'file.txt');
    writeFileSync(filePath, 'hi', 'utf-8');
    const io = bufferedIO();
    const code = await runSchema({ check: filePath }, io);
    expect(code).toBe(1);
    expect(io.err()).toContain(
      '--check must point to an existing directory',
    );
  });

  it('rejects unknown --name BEFORE touching the filesystem', async () => {
    // Use a path that doesn't exist; if the unknown-name check fired
    // first we should still exit 1 with the unknown-name message.
    const ghost = join(tmp, 'absolutely-not-a-dir');
    const io = bufferedIO();
    const code = await runSchema(
      { name: 'oops', check: ghost },
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toContain('unknown schema "oops"');
    expect(io.err()).not.toContain('--check must point');
  });

  it('rejects --out and --check used together', async () => {
    const out = makeTmpDir();
    try {
      const io = bufferedIO();
      const code = await runSchema({ out, check: tmp }, io);
      expect(code).toBe(1);
      expect(io.err()).toContain(
        '--out and --check cannot be used together',
      );
      // No files should leak into either dir.
      expect(readdirSync(out)).toEqual([]);
    } finally {
      cleanupTmp(out);
    }
  });
});

// =============================================================================
// D — main() dispatcher
// =============================================================================

describe('main() — schema --check via dispatcher', () => {
  it('main(["schema", "--check", staticDir]) returns 0', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', '--check', STATIC_SCHEMAS_DIR],
      io,
    );
    expect(code).toBe(0);
    expect(io.out()).toContain('in sync');
  });

  it('supports --check=<path> equals form', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', `--check=${STATIC_SCHEMAS_DIR}`],
      io,
    );
    expect(code).toBe(0);
  });

  it('selective --name + --check via dispatcher', async () => {
    const io = bufferedIO();
    const code = await main(
      [
        'schema',
        '--name',
        'generate-summary',
        '--check',
        STATIC_SCHEMAS_DIR,
      ],
      io,
    );
    expect(code).toBe(0);
  });

  it('supports --name=<id> --check=<path> equals form for both flags', async () => {
    const io = bufferedIO();
    const code = await main(
      [
        'schema',
        '--name=web-zip-summary',
        `--check=${STATIC_SCHEMAS_DIR}`,
      ],
      io,
    );
    expect(code).toBe(0);
  });

  it('main with unknown --name + --check exits 1', async () => {
    const io = bufferedIO();
    const code = await main(
      ['schema', '--name', 'oops', '--check', STATIC_SCHEMAS_DIR],
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toContain('unknown schema "oops"');
  });

  it('help mentions schema --check', async () => {
    const io = bufferedIO();
    const code = await main(['help'], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('--check <dir>');
    expect(io.out()).toContain('plccopilot schema --check');
  });
});

// =============================================================================
// E — regression: existing modes unchanged
// =============================================================================

describe('schema regression — existing modes unchanged by --check addition', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('schema (no flags) still prints cli-result schema to stdout', async () => {
    const io = bufferedIO();
    const code = await main(['schema'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out()) as { $id: string };
    expect(parsed.$id).toContain('cli-result');
  });

  it('schema --out still writes every published file', async () => {
    const io = bufferedIO();
    const code = await main(['schema', '--out', tmp], io);
    expect(code).toBe(0);
    expect(io.out()).toMatch(/Wrote 4 schema files/);
    for (const name of listCliSchemaNames()) {
      expect(existsSync(join(tmp, cliSchemaFileName(name)))).toBe(true);
    }
  });
});

// =============================================================================
// F — --check is strictly read-only
// =============================================================================

describe('schema --check is read-only', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('does NOT modify a changed file', async () => {
    writeAllExpected(tmp);
    const target = join(tmp, 'cli-result.schema.json');
    writeFileSync(target, 'corrupt-marker', 'utf-8');
    await runSchema({ check: tmp }, bufferedIO());
    expect(readFileSync(target, 'utf-8')).toBe('corrupt-marker');
  });

  it('does NOT create a missing file', async () => {
    writeAllExpected(tmp);
    const { rmSync } = await import('node:fs');
    rmSync(join(tmp, 'web-zip-summary.schema.json'));
    await runSchema({ check: tmp }, bufferedIO());
    expect(existsSync(join(tmp, 'web-zip-summary.schema.json'))).toBe(false);
  });

  it('does NOT remove an unexpected file', async () => {
    writeAllExpected(tmp);
    const stranger = join(tmp, 'old.schema.json');
    writeFileSync(stranger, '{}', 'utf-8');
    await runSchema({ check: tmp }, bufferedIO());
    expect(existsSync(stranger)).toBe(true);
  });
});

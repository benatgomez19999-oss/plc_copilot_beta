import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CliGenerateJsonResult,
  CliInspectJsonResult,
  CliJsonErrorResult,
  CliValidateJsonResult,
} from '../src/json-output.js';
import {
  buildErrorPayload,
  buildGeneratePayload,
  countValidateIssues,
} from '../src/json-output.js';
import { serializeCliFailure } from '../src/errors.js';
import { runGenerate } from '../src/commands/generate.js';
import { runValidate } from '../src/commands/validate.js';
import { runInspect } from '../src/commands/inspect.js';
import { main } from '../src/cli.js';
import {
  bufferedIO,
  cleanupTmp,
  fixturePath,
  makeTmpDir,
} from './test-helpers.js';

// `stableJson` from `@plccopilot/codegen-core` formats with 2-space
// indent (pretty-printed multiline). JSON mode emits exactly ONE
// `io.log` call carrying that multiline string, so the buffer's
// `out()` IS the JSON verbatim. Tests parse the full output.
function parseJson<T>(out: string): T {
  return JSON.parse(out) as T;
}

describe('CLI JSON-mode — pure builders', () => {
  it('countValidateIssues buckets severities', () => {
    const counts = countValidateIssues([
      { severity: 'error', rule: 'r1', message: 'm', path: '$' },
      { severity: 'error', rule: 'r2', message: 'm', path: '$' },
      { severity: 'warning', rule: 'r3', message: 'm', path: '$' },
      { severity: 'info', rule: 'r4', message: 'm', path: '$' },
    ]);
    expect(counts).toEqual({ errors: 2, warnings: 1, info: 1 });
  });

  it('buildErrorPayload omits stack by default', () => {
    const e = new Error('oops');
    const payload = buildErrorPayload('generate', e, false);
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe('generate');
    expect(payload.error.stack).toBeUndefined();
  });

  it('buildErrorPayload includes stack when debug=true', () => {
    const e = new Error('oops');
    const payload = buildErrorPayload('generate', e, true);
    expect(typeof payload.error.stack).toBe('string');
    expect(payload.error.stack!.length).toBeGreaterThan(0);
  });

  it('serializeCliFailure unwraps CliError.cause', async () => {
    const { CliError } = await import('../src/errors.js');
    const inner = new Error('inner reason');
    const outer = new CliError('outer message', 1, inner);
    const s = serializeCliFailure(outer);
    expect(s.message).toBe('inner reason');
  });

  it('buildGeneratePayload preserves run array order', () => {
    const payload = buildGeneratePayload({
      backend: 'all',
      outDir: '/tmp/out',
      artifactCount: 0,
      writtenFiles: [],
      diagnostics: { errors: 0, warnings: 0, info: 0 },
      summaryPath: '/tmp/out/summary.json',
      runs: [
        { backend: 'siemens', artifact_count: 1, diagnostics: { errors: 0, warnings: 0, info: 0 } },
        { backend: 'codesys', artifact_count: 2, diagnostics: { errors: 0, warnings: 0, info: 0 } },
        { backend: 'rockwell', artifact_count: 3, diagnostics: { errors: 0, warnings: 0, info: 0 } },
      ],
    });
    expect(payload.runs!.map((r) => r.backend)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
  });
});

// =============================================================================
// generate --json
// =============================================================================

describe('generate --json', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('siemens happy path emits one stable JSON, exit 0, empty stderr', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      {
        input: fixturePath(),
        backend: 'siemens',
        out: tmp,
        json: true,
      },
      io,
    );
    expect(code).toBe(0);
    expect(io.err()).toBe('');
    // No human "Generated N artifacts..." line in JSON mode.
    expect(io.out()).not.toMatch(/Generated \d+ artifacts/);
    const payload = parseJson<CliGenerateJsonResult>(io.out());
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('generate');
    expect(payload.backend).toBe('siemens');
    expect(payload.artifact_count).toBeGreaterThan(0);
    expect(Array.isArray(payload.written_files)).toBe(true);
    expect(payload.written_files.length).toBe(payload.artifact_count);
    expect(payload.summary_path.endsWith('summary.json')).toBe(true);
    expect(typeof payload.diagnostics.errors).toBe('number');
    expect(typeof payload.diagnostics.warnings).toBe('number');
    expect(typeof payload.diagnostics.info).toBe('number');
    expect(typeof payload.generated_at).toBe('string');
  });

  it('--backend all returns runs[] in stable order with deterministic count math', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'all', out: tmp, json: true },
      io,
    );
    expect(code).toBe(0);
    const payload = parseJson<CliGenerateJsonResult>(io.out());
    expect(payload.backend).toBe('all');
    expect(payload.runs).toBeDefined();
    expect(payload.runs!.map((r) => r.backend)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
    const sumOfRuns = payload.runs!.reduce(
      (a, r) => a + r.artifact_count,
      0,
    );
    expect(sumOfRuns).toBe(payload.artifact_count);
  });

  // Build a PIR with a recipe pointing at a non-existent parameter so
  // `buildDbRecipesIR` raises UNKNOWN_PARAMETER.
  function writeProjectWithGhostRecipeParam(): string {
    const raw = readFileSync(fixturePath(), 'utf-8');
    const project = JSON.parse(raw) as {
      machines: {
        recipes: { id: string; values: Record<string, number | boolean> }[];
      }[];
    };
    const recipe = project.machines[0]!.recipes[0]!;
    recipe.values = { ...recipe.values, p_ghost_param: 1 };
    const path = join(tmp, 'ghost-param.json');
    writeFileSync(path, JSON.stringify(project), 'utf-8');
    return path;
  }

  it('UNKNOWN_PARAMETER → exit 1, JSON error with full metadata, no stack', async () => {
    const input = writeProjectWithGhostRecipeParam();
    const io = bufferedIO();
    const code = await runGenerate(
      { input, backend: 'siemens', out: tmp, json: true },
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    const payload = parseJson<CliJsonErrorResult>(io.out());
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe('generate');
    expect(payload.error.code).toBe('UNKNOWN_PARAMETER');
    expect(payload.error.path).toMatch(
      /^machines\[0\]\.recipes\[\d+\]\.values\.p_ghost_param$/,
    );
    expect(payload.error.symbol).toBe('p_ghost_param');
    expect(typeof payload.error.hint).toBe('string');
    expect(payload.error.stack).toBeUndefined();
  });

  it('--debug populates error.stack', async () => {
    const input = writeProjectWithGhostRecipeParam();
    const io = bufferedIO();
    const code = await runGenerate(
      { input, backend: 'siemens', out: tmp, json: true, debug: true },
      io,
    );
    expect(code).toBe(1);
    const payload = parseJson<CliJsonErrorResult>(io.out());
    expect(typeof payload.error.stack).toBe('string');
    expect(payload.error.stack!.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// validate --json
// =============================================================================

describe('validate --json', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('weldline fixture validates ok with structured issues + counts payload', async () => {
    const io = bufferedIO();
    const code = await runValidate(
      { input: fixturePath(), json: true },
      io,
    );
    // weldline may produce non-error issues (warnings/info); the
    // contract is "exit 0 iff report.ok is true" — which holds when
    // there are zero severity-error issues.
    expect(code).toBe(0);
    const payload = parseJson<CliValidateJsonResult>(io.out());
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('validate');
    expect(payload.project_id).toBe('prj_weldline');
    expect(Array.isArray(payload.issues)).toBe(true);
    // No error-severity issues by definition (report.ok === true).
    expect(payload.counts.errors).toBe(0);
    expect(typeof payload.counts.warnings).toBe('number');
    expect(typeof payload.counts.info).toBe('number');
    // Counts match issues array.
    const recount = payload.issues.reduce(
      (acc, i) => ({
        errors: acc.errors + (i.severity === 'error' ? 1 : 0),
        warnings: acc.warnings + (i.severity === 'warning' ? 1 : 0),
        info: acc.info + (i.severity === 'info' ? 1 : 0),
      }),
      { errors: 0, warnings: 0, info: 0 },
    );
    expect(recount).toEqual(payload.counts);
  });

  it('schema mismatch emits JSON error, exit 1, no stack', async () => {
    const bad = join(tmp, 'not-pir.json');
    writeFileSync(bad, JSON.stringify({ unrelated: 'shape' }), 'utf-8');
    const io = bufferedIO();
    const code = await runValidate({ input: bad, json: true }, io);
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    const payload = parseJson<CliJsonErrorResult>(io.out());
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe('validate');
    expect(payload.error.message).toMatch(/PIR schema validation failed/);
    expect(payload.error.stack).toBeUndefined();
  });
});

// =============================================================================
// inspect --json
// =============================================================================

describe('inspect --json', () => {
  it('weldline fixture emits structured project + counts + supported_backends', async () => {
    const io = bufferedIO();
    const code = await runInspect(
      { input: fixturePath(), json: true },
      io,
    );
    expect(code).toBe(0);
    const payload = parseJson<CliInspectJsonResult>(io.out());
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('inspect');
    expect(payload.project.id).toBe('prj_weldline');
    expect(payload.counts.machines).toBe(1);
    expect(payload.counts.stations).toBeGreaterThan(0);
    expect(payload.machines).toHaveLength(1);
    expect(payload.supported_backends).toEqual([
      'siemens',
      'codesys',
      'rockwell',
      'all',
    ]);
  });
});

// =============================================================================
// main() dispatcher in JSON mode
// =============================================================================

describe('main() — JSON dispatch', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('unknown command emits JSON error to stdout, empty stderr, exit 1', async () => {
    const io = bufferedIO();
    const code = await main(['totally-unknown', '--json'], io);
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    const payload = parseJson<CliJsonErrorResult>(io.out());
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe('unknown');
    expect(payload.error.message).toContain('totally-unknown');
  });

  it('missing required flag for generate emits JSON error', async () => {
    const io = bufferedIO();
    const code = await main(['generate', '--json'], io);
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    const payload = parseJson<CliJsonErrorResult>(io.out());
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe('generate');
    expect(payload.error.message).toMatch(/missing required flag/);
  });

  it('invalid backend emits JSON error', async () => {
    const io = bufferedIO();
    const code = await main(
      [
        'generate',
        '--input',
        fixturePath(),
        '--backend',
        'siemens-x',
        '--out',
        tmp,
        '--json',
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toBe('');
    const payload = parseJson<CliJsonErrorResult>(io.out());
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe('generate');
    expect(payload.error.message).toMatch(/invalid --backend/);
  });
});

// =============================================================================
// Human mode regression — sprint 45 must not change default output
// =============================================================================

describe('human mode regression — no JSON flag = unchanged stdout', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('generate without --json keeps the existing human summary', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    expect(code).toBe(0);
    expect(io.out()).toMatch(/Generated \d+ artifacts for backend siemens/);
    expect(io.out()).toMatch(/Diagnostics: \d+ info, \d+ warning, \d+ errors/);
  });

  it('validate without --json keeps the existing human summary line', async () => {
    const io = bufferedIO();
    const code = await runValidate({ input: fixturePath() }, io);
    expect(code).toBe(0);
    expect(io.out()).toMatch(/Validation: \d+ errors, \d+ warnings, \d+ info/);
  });
});

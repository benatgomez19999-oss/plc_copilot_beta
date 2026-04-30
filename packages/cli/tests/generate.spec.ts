import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGenerate } from '../src/commands/generate.js';
import { writeArtifacts } from '../src/io/write-artifacts.js';
import {
  bufferedIO,
  cleanupTmp,
  fixturePath,
  makeTmpDir,
} from './test-helpers.js';

describe('generate command — Siemens', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('writes Siemens artifacts + summary.json into the output dir', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tmp, 'siemens/FB_StLoad.scl'))).toBe(true);
    expect(existsSync(join(tmp, 'siemens/FB_StWeld.scl'))).toBe(true);
    expect(existsSync(join(tmp, 'siemens/FB_Alarms.scl'))).toBe(true);
    expect(existsSync(join(tmp, 'siemens/Tags_Main.csv'))).toBe(true);
    expect(existsSync(join(tmp, 'siemens/manifest.json'))).toBe(true);
    expect(existsSync(join(tmp, 'summary.json'))).toBe(true);
  });

  it('summary.json carries backend + diagnostic counts + artifact list', async () => {
    const io = bufferedIO();
    await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    const summary = JSON.parse(readFileSync(join(tmp, 'summary.json'), 'utf-8'));
    expect(summary.backend).toBe('siemens');
    expect(summary.artifact_count).toBeGreaterThan(0);
    expect(summary.diagnostics).toEqual({
      errors: expect.any(Number),
      warnings: expect.any(Number),
      info: expect.any(Number),
    });
    expect(summary.diagnostics.errors).toBe(0);
    expect(Array.isArray(summary.artifacts)).toBe(true);
    expect(summary.artifacts).toContain('siemens/manifest.json');
  });

  it('prints the summary line to stdout', async () => {
    const io = bufferedIO();
    await runGenerate(
      { input: fixturePath(), backend: 'siemens', out: tmp },
      io,
    );
    expect(io.out()).toMatch(/Generated \d+ artifacts for backend siemens/);
    expect(io.out()).toMatch(/Diagnostics: \d+ info, \d+ warning, \d+ errors/);
  });

  it('returns exit code 1 when input file is missing', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: '/no/such/file.json', backend: 'siemens', out: tmp },
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toMatch(/cannot read PIR file/);
  });

  it('returns exit code 1 when JSON is malformed', async () => {
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf-8');
    const io = bufferedIO();
    const code = await runGenerate(
      { input: bad, backend: 'siemens', out: tmp },
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toMatch(/invalid JSON/);
  });

  it('two consecutive runs produce byte-identical artifacts (determinism)', async () => {
    const tmp2 = makeTmpDir();
    try {
      await runGenerate(
        {
          input: fixturePath(),
          backend: 'siemens',
          out: tmp,
          generatedAt: '2026-04-26T00:00:00Z',
        },
        bufferedIO(),
      );
      await runGenerate(
        {
          input: fixturePath(),
          backend: 'siemens',
          out: tmp2,
          generatedAt: '2026-04-26T00:00:00Z',
        },
        bufferedIO(),
      );
      const a = readFileSync(join(tmp, 'siemens/FB_StLoad.scl'), 'utf-8');
      const b = readFileSync(join(tmp2, 'siemens/FB_StLoad.scl'), 'utf-8');
      expect(a).toBe(b);
      const m1 = readFileSync(join(tmp, 'siemens/manifest.json'), 'utf-8');
      const m2 = readFileSync(join(tmp2, 'siemens/manifest.json'), 'utf-8');
      expect(m1).toBe(m2);
    } finally {
      cleanupTmp(tmp2);
    }
  });
});

describe('generate command — all backends', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('writes Siemens + Codesys + Rockwell artifacts in one run', async () => {
    const io = bufferedIO();
    const code = await runGenerate(
      { input: fixturePath(), backend: 'all', out: tmp },
      io,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tmp, 'siemens/FB_StLoad.scl'))).toBe(true);
    expect(existsSync(join(tmp, 'codesys/FB_StLoad.st'))).toBe(true);
    expect(existsSync(join(tmp, 'rockwell/FB_StLoad.st'))).toBe(true);
  });

  it('summary.json has runs[] for each of the three backends', async () => {
    await runGenerate(
      { input: fixturePath(), backend: 'all', out: tmp },
      bufferedIO(),
    );
    const summary = JSON.parse(readFileSync(join(tmp, 'summary.json'), 'utf-8'));
    expect(summary.backend).toBe('all');
    expect(Array.isArray(summary.runs)).toBe(true);
    expect(summary.runs.map((r: { backend: string }) => r.backend)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
    for (const run of summary.runs) {
      expect(run.artifact_count).toBeGreaterThan(0);
      expect(run.diagnostics.errors).toBe(0);
    }
  });
});

describe('generate command — invalid backend flag', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('returns exit code 1 when backend value is unknown', async () => {
    // The dispatcher rejects unknown backends; runGenerate is called only
    // with a typed value. We exercise the dispatcher in cli.spec via main().
    // Here we just confirm that runGenerate refuses to write without out.
    // (Type-level enforcement covers most call sites; this is a runtime
    //  check for hand-built calls in tooling.)
    const io = bufferedIO();
    // Cast a knowingly-bad backend to satisfy the type at the call site.
    const code = await runGenerate(
      // @ts-expect-error testing runtime guard
      { input: fixturePath(), backend: 'unknown', out: tmp },
      io,
    );
    // No backend dispatch matched → falls through and returns 1.
    expect(code).toBe(1);
  });
});

describe('generate command — codegen errors (sprint 39)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  // Build a tweaked PIR that triggers `UNKNOWN_PARAMETER` during
  // `buildDbRecipesIR`: a recipe references a parameter id that
  // doesn't exist in `machine.parameters`. We start from the
  // canonical weldline fixture so the rest of the project stays
  // schema-valid.
  function writeProjectWithGhostRecipeParam(): string {
    const raw = readFileSync(fixturePath(), 'utf-8');
    const project = JSON.parse(raw) as {
      machines: {
        recipes: { id: string; values: Record<string, number | boolean> }[];
      }[];
    };
    const recipe = project.machines[0]!.recipes[0]!;
    recipe.values = { ...recipe.values, p_ghost_param: 1 };
    const path = join(tmp, 'with-ghost-param.json');
    writeFileSync(path, JSON.stringify(project), 'utf-8');
    return path;
  }

  it('exits 1 and prints [UNKNOWN_PARAMETER] with recipe + param + hint', async () => {
    const input = writeProjectWithGhostRecipeParam();
    const io = bufferedIO();
    const code = await runGenerate(
      { input, backend: 'siemens', out: tmp },
      io,
    );
    expect(code).toBe(1);
    const stderr = io.err();
    expect(stderr).toContain('[UNKNOWN_PARAMETER]');
    // Recipe id from the weldline fixture.
    expect(stderr).toMatch(/Recipe ".+" references unknown parameter "p_ghost_param"/);
    // Symbol metadata surfaced via the formatter parens group.
    expect(stderr).toContain('symbol: p_ghost_param');
    // Hint surfaced verbatim.
    expect(stderr).toContain(
      'Hint: Define the parameter in machine.parameters or remove it from the recipe.',
    );
    // Stack trace is intentionally suppressed in default UX.
    expect(stderr).not.toMatch(/\bat \w/);
  });

  it('tags the failing backend when running --backend all', async () => {
    const input = writeProjectWithGhostRecipeParam();
    const io = bufferedIO();
    const code = await runGenerate(
      { input, backend: 'all', out: tmp },
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toMatch(/^\[siemens\] \[UNKNOWN_PARAMETER\]/);
  });

  // Sprint 40 / 86 / 87A / 87C — UNSUPPORTED_EQUIPMENT carries
  // stationId + symbol + path + hint via the rolled-up
  // READINESS_FAILED CodegenError. The fixture flips an existing
  // equipment to `valve_onoff` and runs the **rockwell** backend.
  // Why Rockwell: Sprint 87A added valve_onoff for CODESYS only;
  // Sprint 87C widened Siemens after the SCL renderer audit.
  // Rockwell stays narrow (Logix renderer not yet audited), so it
  // is the only target that still surfaces READINESS_FAILED for
  // valve_onoff — the exact UX we want to test here.
  function writeProjectWithUnsupportedEquipment(): string {
    const raw = readFileSync(fixturePath(), 'utf-8');
    const project = JSON.parse(raw) as {
      machines: {
        stations: { id: string; equipment: { id: string; type: string }[] }[];
      }[];
    };
    project.machines[0]!.stations[0]!.equipment[0]!.type = 'valve_onoff';
    const path = join(tmp, 'with-unsupported-equipment.json');
    writeFileSync(path, JSON.stringify(project), 'utf-8');
    return path;
  }

  it('exits 1 with [READINESS_FAILED] + station + symbol + hint (sprint 86 / 87C)', async () => {
    const input = writeProjectWithUnsupportedEquipment();
    const io = bufferedIO();
    const code = await runGenerate(
      { input, backend: 'rockwell', out: tmp },
      io,
    );
    expect(code).toBe(1);
    const stderr = io.err();
    expect(stderr).toContain('[READINESS_FAILED]');
    // The roll-up names the offending equipment type.
    expect(stderr).toContain('valve_onoff');
    // The roll-up names the rejecting target.
    expect(stderr).toContain('rockwell');
    // Path points at the offending field (carried via the readiness
    // diagnostic into the wrapper error).
    expect(stderr).toContain('machines[0].stations[0].equipment[0].type');
    // Station + symbol metadata in the parens group.
    expect(stderr).toMatch(/station: \w+/);
    expect(stderr).toMatch(/symbol: \w+/);
    // Hint enumerates the supported types for the target (Rockwell
    // baseline still includes the original three kinds).
    expect(stderr).toContain('Hint: ');
    expect(stderr).toMatch(/pneumatic_cylinder_2pos|motor_simple/);
    // The original per-diagnostic code surfaces inside the rolled-up message body.
    expect(stderr).toContain('READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET');
    // No stack trace by default.
    expect(stderr).not.toMatch(/\bat \w/);
  });
});

describe('writeArtifacts — security guards', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('rejects an artifact whose path escapes outDir via `..`', () => {
    expect(() =>
      writeArtifacts(tmp, [
        { path: '../escape.txt', kind: 'st', content: 'pwned' },
      ]),
    ).toThrow(/escapes output dir/);
  });

  it('rejects an absolute artifact path', () => {
    expect(() =>
      writeArtifacts(tmp, [
        { path: '/etc/passwd', kind: 'st', content: 'pwned' },
      ]),
    ).toThrow(/absolute artifact path/);
  });

  it('writes nested artifacts (creates intermediate dirs)', () => {
    const written = writeArtifacts(tmp, [
      { path: 'siemens/sub/dir/file.scl', kind: 'scl', content: 'hello' },
    ]);
    expect(written).toHaveLength(1);
    expect(existsSync(join(tmp, 'siemens/sub/dir/file.scl'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { compileProject } from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// Sprint 42 — moved from raw-substring `.toContain` to regex with
// word boundaries so the legitimate JSON path fragment `.stations`
// (now used by lowering diagnostics) doesn't trigger the `.st` file-
// extension guard. The intent was always "no backend FILE EXTENSION
// or directory prefix in core output", not "literally these
// substrings anywhere".
const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /siemens\//,
  /codesys\//,
  /rockwell\//,
  /\.scl\b/,
  /\.st\b/,
  /\.csv\b/,
];

function assertNoBackendPath(value: string | undefined, ctx: string): void {
  if (value === undefined) return;
  for (const pat of FORBIDDEN_PATH_PATTERNS) {
    expect(value, `${ctx} contains forbidden fragment ${pat.source}`).not.toMatch(pat);
  }
}

describe('compileProject (core) — backend-neutral output', () => {
  const program = compileProject(clone());

  it('produces blocks with logical names only', () => {
    for (const b of program.blocks) {
      expect(b.name).toMatch(/^FB_[A-Za-z][A-Za-z0-9_]*$/);
      assertNoBackendPath(b.name, `block ${b.name}.name`);
    }
  });

  it('produces typeArtifacts with logical names only', () => {
    for (const t of program.typeArtifacts) {
      expect(t.name).toMatch(/^UDT_[A-Za-z][A-Za-z0-9_]*$/);
      assertNoBackendPath(t.name, `type ${t.name}.name`);
      assertNoBackendPath(t.path, `type ${t.name}.path`);
    }
  });

  it('produces dataBlocks with logical names only', () => {
    for (const d of program.dataBlocks) {
      expect(d.name).toMatch(/^DB_[A-Za-z][A-Za-z0-9_]*$/);
      assertNoBackendPath(d.name, `dataBlock ${d.name}.name`);
    }
  });

  it('produces tagTables with logical name + neutral rows (no path/content/format)', () => {
    expect(program.tagTables.length).toBeGreaterThan(0);
    for (const tt of program.tagTables) {
      expect(tt.name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      expect(tt.kind).toBe('main');
      expect(Array.isArray(tt.rows)).toBe(true);
      // Neutral fields only — no rendered content / no backend path / no format.
      // Cast goes through `unknown` because the IR types don't carry an index
      // signature; we want to assert the absence of a property whose name
      // isn't in the type. `as unknown as Record<…>` keeps the assertion
      // honest without weakening the production type.
      const bag = tt as unknown as Record<string, unknown>;
      expect(bag.path).toBeUndefined();
      expect(bag.content).toBeUndefined();
      expect(bag.format).toBeUndefined();
    }
  });

  it('manifest carries metadata only — no backend path / generator / artifactPaths', () => {
    expect(program.manifest.path).toBeUndefined();
    expect(program.manifest.generator).toBeUndefined();
    expect(program.manifest.artifactPaths).toBeUndefined();
    expect(program.manifest.target).toBeUndefined();
    // Required core fields stay populated
    expect(program.manifest.pirVersion).toBe('0.1.0');
    expect(program.manifest.projectId).toBe('prj_weldline');
    expect(program.manifest.generatedAt).toBeDefined();
    expect(typeof program.manifest.generatedAt).toBe('string');
    expect(Array.isArray(program.manifest.compilerDiagnostics)).toBe(true);
    expect(program.manifest.features).toBeDefined();
  });

  it('target is present but empty (backends fill at render time)', () => {
    expect(program.target).toEqual({});
  });

  it('diagnostics carry logical paths only — no backend filesystem fragments', () => {
    for (const d of program.diagnostics) {
      assertNoBackendPath(d.path, `diagnostic ${d.code}.path`);
    }
  });
});

describe('compileProject (core) — feature flags + diagnostics', () => {
  it('emits ALARMS_AS_LOOSE_TAGS info when useDbAlarms=false', () => {
    const program = compileProject(clone(), {
      features: { useDbAlarms: false },
    });
    expect(
      program.diagnostics.some(
        (d) => d.code === 'ALARMS_AS_LOOSE_TAGS' && d.severity === 'info',
      ),
    ).toBe(true);
  });

  it('drops DB_Alarms from dataBlocks when useDbAlarms=false', () => {
    const program = compileProject(clone(), {
      features: { useDbAlarms: false },
    });
    expect(
      program.dataBlocks.some((d) => d.name === 'DB_Alarms'),
    ).toBe(false);
  });

  it('drops FB_Alarms from blocks when useDbAlarms=false', () => {
    const program = compileProject(clone(), {
      features: { useDbAlarms: false },
    });
    expect(program.blocks.some((b) => b.name === 'FB_Alarms')).toBe(false);
  });

  it('is deterministic across two independent runs', () => {
    const a = compileProject(clone(), { generatedAt: '2026-04-26T00:00:00Z' });
    const b = compileProject(clone(), { generatedAt: '2026-04-26T00:00:00Z' });
    expect(a.blocks.map((x) => x.name)).toEqual(b.blocks.map((x) => x.name));
    expect(a.typeArtifacts.map((t) => t.fields)).toEqual(
      b.typeArtifacts.map((t) => t.fields),
    );
    expect(a.dataBlocks.map((d) => d.fields)).toEqual(
      b.dataBlocks.map((d) => d.fields),
    );
    expect(a.tagTables.map((t) => t.rows)).toEqual(
      b.tagTables.map((t) => t.rows),
    );
    expect(a.diagnostics).toEqual(b.diagnostics);
  });
});

describe('compileProject (core) — tagTables row structure', () => {
  const program = compileProject(clone());

  it('has at least one io row with structured PIR address (no Siemens %I0.0 string)', () => {
    const main = program.tagTables[0]!;
    const ioRows = main.rows.filter((r) => r.source === 'io');
    expect(ioRows.length).toBeGreaterThan(0);
    for (const row of ioRows) {
      // Structured address only — no rendered Siemens-style strings.
      if (row.ioAddress) {
        expect(row.ioAddress).not.toBeNull();
        expect(typeof row.ioAddress.byte).toBe('number');
        expect(typeof row.ioAddress.memory_area).toBe('string');
      }
      expect(row.dataType).toMatch(/^(Bool|Int|DInt|Real|Variant)$/);
    }
  });

  it('has parameter rows with no address (parameters live in DB_Global_Params)', () => {
    const main = program.tagTables[0]!;
    const paramRows = main.rows.filter((r) => r.source === 'parameter');
    for (const row of paramRows) {
      expect(row.ioAddress).toBeUndefined();
    }
  });

  it('has one station_state row per station', () => {
    const main = program.tagTables[0]!;
    const stationRows = main.rows.filter((r) => r.source === 'station_state');
    expect(stationRows.length).toBe(2); // st_load + st_weld
    for (const row of stationRows) {
      expect(row.dataType).toBe('Int');
      expect(row.name.endsWith('_state')).toBe(true);
    }
  });
});

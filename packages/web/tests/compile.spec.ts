import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { compilePir } from '../src/compiler/compile.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = '2026-04-26T00:00:00Z';

describe('compilePir — single backend', () => {
  it('returns Siemens artifacts + summary fields', () => {
    const r = compilePir(clone(), 'siemens', { generatedAt: CLOCK });
    expect(r.backend).toBe('siemens');
    expect(r.artifacts.length).toBeGreaterThan(0);
    expect(r.artifacts.every((a) => a.path.startsWith('siemens/'))).toBe(true);
    expect(r.summary.artifactCount).toBe(r.artifacts.length);
    expect(r.summary.errors + r.summary.warnings + r.summary.info).toBe(
      r.diagnostics.length,
    );
  });

  it('returns Codesys artifacts under codesys/ prefix', () => {
    const r = compilePir(clone(), 'codesys', { generatedAt: CLOCK });
    expect(r.backend).toBe('codesys');
    expect(r.artifacts.every((a) => a.path.startsWith('codesys/'))).toBe(true);
  });

  it('returns Rockwell artifacts under rockwell/ prefix', () => {
    const r = compilePir(clone(), 'rockwell', { generatedAt: CLOCK });
    expect(r.backend).toBe('rockwell');
    expect(r.artifacts.every((a) => a.path.startsWith('rockwell/'))).toBe(true);
  });

  it('weldline fixture compiles cleanly with zero error diagnostics on each backend', () => {
    for (const b of ['siemens', 'codesys', 'rockwell'] as const) {
      const r = compilePir(clone(), b, { generatedAt: CLOCK });
      expect(r.summary.errors, `${b} should have no error diagnostics`).toBe(0);
    }
  });
});

describe('compilePir — backend=all', () => {
  it('concatenates artifacts from the three backends', () => {
    const r = compilePir(clone(), 'all', { generatedAt: CLOCK });
    expect(r.backend).toBe('all');

    const sieCount = r.artifacts.filter((a) =>
      a.path.startsWith('siemens/'),
    ).length;
    const codCount = r.artifacts.filter((a) =>
      a.path.startsWith('codesys/'),
    ).length;
    const rocCount = r.artifacts.filter((a) =>
      a.path.startsWith('rockwell/'),
    ).length;

    expect(sieCount).toBeGreaterThan(0);
    expect(codCount).toBeGreaterThan(0);
    expect(rocCount).toBeGreaterThan(0);
    expect(sieCount + codCount + rocCount).toBe(r.artifacts.length);
  });

  it('aggregates ARTIFACT-level diagnostics across the three backends', () => {
    // MVP contract (documented in README): we aggregate `artifact.diagnostics`
    // only — i.e., the diagnostics each backend attaches to station FB
    // artifacts. Manifest-only entries (ROCKWELL_EXPERIMENTAL_BACKEND,
    // ROCKWELL_NO_L5X_EXPORT, etc.) are surfaced via each backend's
    // `<dir>/manifest.json` artifact content but NOT double-counted here.
    const r = compilePir(clone(), 'all', { generatedAt: CLOCK });
    const counted =
      r.summary.errors + r.summary.warnings + r.summary.info;
    expect(counted).toBe(r.diagnostics.length);
    // Station-scoped diagnostics DO appear on station FB artifacts and
    // therefore reach the aggregation.
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('TIMEOUT_NO_AUTO_TRANSITION');
  });
});

describe('compilePir — determinism', () => {
  it('two consecutive runs with the same generatedAt produce identical artifacts', () => {
    const a = compilePir(clone(), 'siemens', { generatedAt: CLOCK });
    const b = compilePir(clone(), 'siemens', { generatedAt: CLOCK });
    expect(a.artifacts.map((x) => x.content)).toEqual(
      b.artifacts.map((x) => x.content),
    );
    expect(a.diagnostics).toEqual(b.diagnostics);
  });

  it('all-backends run is deterministic across two invocations', () => {
    const a = compilePir(clone(), 'all', { generatedAt: CLOCK });
    const b = compilePir(clone(), 'all', { generatedAt: CLOCK });
    expect(a.artifacts.map((x) => x.path)).toEqual(
      b.artifacts.map((x) => x.path),
    );
    expect(a.artifacts.map((x) => x.content)).toEqual(
      b.artifacts.map((x) => x.content),
    );
  });
});

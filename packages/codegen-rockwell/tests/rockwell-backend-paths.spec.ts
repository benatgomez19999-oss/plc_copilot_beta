import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateRockwellProject } from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-26T00:00:00Z' } };

/**
 * Rockwell backend physical paths. The Rockwell façade now consumes the
 * neutral ProgramIR from core directly; this test verifies the documented
 * `rockwell/*.st` + `rockwell/manifest.json` layout.
 */
describe('rockwell backend — physical artifact paths', () => {
  const artifacts = generateRockwellProject(clone(), CLOCK);
  const paths = artifacts.map((a) => a.path);

  it('every artifact path is rooted at `rockwell/`', () => {
    for (const p of paths) expect(p.startsWith('rockwell/')).toBe(true);
  });

  it('non-manifest artifacts use `.st`; manifest uses `.json`', () => {
    expect(paths.filter((p) => p.endsWith('.json'))).toEqual([
      'rockwell/manifest.json',
    ]);
    expect(paths.filter((p) => p.endsWith('.st')).length).toBeGreaterThan(0);
    expect(paths.some((p) => p.endsWith('.scl'))).toBe(false);
  });

  it('canonical Rockwell artifact set', () => {
    expect(paths).toEqual([
      'rockwell/FB_StLoad.st',
      'rockwell/FB_StWeld.st',
      'rockwell/FB_Alarms.st',
      'rockwell/UDT_Cylinder2Pos.st',
      'rockwell/UDT_MotorSimple.st',
      'rockwell/TAG_Parameters.st',
      'rockwell/TAG_Recipes.st',
      'rockwell/TAG_Alarms.st',
      'rockwell/manifest.json',
    ]);
  });

  it('manifest declares backend = rockwell + experimental = true', () => {
    const manifest = artifacts.find(
      (a) => a.path === 'rockwell/manifest.json',
    )!;
    const data = JSON.parse(manifest.content) as {
      backend: string;
      experimental: boolean;
      target: { vendor: string };
    };
    expect(data.backend).toBe('rockwell');
    expect(data.experimental).toBe(true);
    expect(data.target.vendor).toBe('rockwell_logix5000');
  });

  it('no Siemens or Codesys paths leak into the Rockwell bundle', () => {
    for (const p of paths) {
      expect(p).not.toContain('siemens/');
      expect(p).not.toContain('codesys/');
    }
  });

  it('output is deterministic across two runs', () => {
    const a = generateRockwellProject(clone(), CLOCK);
    const b = generateRockwellProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
  });
});

import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateCodesysProject } from '../src/index.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-26T00:00:00Z' } };

/**
 * Codesys backend physical paths. Validates that the Codesys façade — which
 * now consumes the vendor-neutral ProgramIR from `@plccopilot/codegen-core`
 * directly — still emits the documented `codesys/*.st` + `codesys/manifest.json`
 * layout.
 */
describe('codesys backend — physical artifact paths', () => {
  const artifacts = generateCodesysProject(clone(), CLOCK);
  const paths = artifacts.map((a) => a.path);

  it('every artifact path is rooted at `codesys/`', () => {
    for (const p of paths) expect(p.startsWith('codesys/')).toBe(true);
  });

  it('non-manifest artifacts use `.st`; manifest uses `.json`', () => {
    expect(paths.filter((p) => p.endsWith('.json'))).toEqual([
      'codesys/manifest.json',
    ]);
    expect(paths.filter((p) => p.endsWith('.st')).length).toBeGreaterThan(0);
    expect(paths.some((p) => p.endsWith('.scl'))).toBe(false);
  });

  it('emits one .st per station + the alarm manager + GVL_Alarms', () => {
    expect(paths).toContain('codesys/FB_StLoad.st');
    expect(paths).toContain('codesys/FB_StWeld.st');
    expect(paths).toContain('codesys/FB_Alarms.st');
    expect(paths).toContain('codesys/GVL_Alarms.st');
  });

  it('manifest declares backend = codesys', () => {
    const manifest = artifacts.find((a) => a.path === 'codesys/manifest.json')!;
    const data = JSON.parse(manifest.content) as {
      backend: string;
      experimental: boolean;
      target: { vendor: string };
    };
    expect(data.backend).toBe('codesys');
    expect(data.experimental).toBe(true);
    expect(data.target.vendor).toBe('codesys_iec61131');
  });

  it('no Siemens or Rockwell paths leak into the Codesys bundle', () => {
    for (const p of paths) {
      expect(p).not.toContain('siemens/');
      expect(p).not.toContain('rockwell/');
    }
  });

  it('output is deterministic across two runs', () => {
    const a = generateCodesysProject(clone(), CLOCK);
    const b = generateCodesysProject(clone(), CLOCK);
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
  });
});

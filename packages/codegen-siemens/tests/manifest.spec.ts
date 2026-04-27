import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateSiemensProject } from '../src/generators/project.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-24T00:00:00Z' } };

interface ManifestShape {
  generator: string;
  version: string;
  pir_version: string;
  project_id: string;
  project_name: string;
  target: { vendor: string; tia_version: string };
  features: {
    use_db_alarms: boolean;
    emit_fb_alarms: boolean;
    emit_diagnostics_in_manifest: boolean;
    strict_diagnostics: boolean;
  };
  artifacts: string[];
  generated_at: string;
  compiler_diagnostics?: Array<{
    code: string;
    severity: string;
    message: string;
    path?: string;
    station_id?: string;
    symbol?: string;
    hint?: string;
  }>;
}

function loadManifest(
  opts: Parameters<typeof generateSiemensProject>[1] = CLOCK,
): ManifestShape {
  const artifacts = generateSiemensProject(clone(), opts);
  const manifest = artifacts.find((a) => a.path.endsWith('manifest.json'))!;
  return JSON.parse(manifest.content) as ManifestShape;
}

/** Helper that asserts compiler_diagnostics is present and returns the array. */
function diagnosticsOf(
  data: ManifestShape,
): NonNullable<ManifestShape['compiler_diagnostics']> {
  if (!data.compiler_diagnostics) {
    throw new Error(
      'expected compiler_diagnostics to be present on the manifest',
    );
  }
  return data.compiler_diagnostics;
}

describe('manifest.json — compiler_diagnostics integration', () => {
  it('exposes a compiler_diagnostics array on the manifest', () => {
    const data = loadManifest();
    const diags = diagnosticsOf(data);
    expect(Array.isArray(diags)).toBe(true);
    expect(diags.length).toBeGreaterThan(0);
  });

  it('includes every info diagnostic (e.g., TIMEOUT_NO_AUTO_TRANSITION)', () => {
    const diags = diagnosticsOf(loadManifest());
    expect(
      diags.some(
        (d) =>
          d.code === 'TIMEOUT_NO_AUTO_TRANSITION' && d.severity === 'info',
      ),
    ).toBe(true);
  });

  it('serialises station_id in snake_case', () => {
    const diags = diagnosticsOf(loadManifest());
    // At least one diagnostic from st_load should appear.
    expect(diags.some((d) => d.station_id === 'st_load')).toBe(true);
  });

  it('diagnostics are deterministically ordered across two runs', () => {
    const a = loadManifest();
    const b = loadManifest();
    expect(a.compiler_diagnostics).toEqual(b.compiler_diagnostics);
  });

  it('diagnostics are deduplicated (no two entries with identical shape)', () => {
    const diags = diagnosticsOf(loadManifest());
    const keys = diags.map((d) =>
      [
        d.code,
        d.severity,
        d.path ?? '',
        d.station_id ?? '',
        d.symbol ?? '',
        d.message,
      ].join(' '),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('manifest artifact list excludes manifest.json itself', () => {
    const data = loadManifest();
    expect(data.artifacts).not.toContain('manifest.json');
    expect(data.artifacts).toContain('DB_Alarms.scl');
    expect(data.artifacts).toContain('FB_Alarms.scl');
  });

  it('exposes vendor + tia_version under target (snake_case)', () => {
    const data = loadManifest();
    expect(data.target.vendor).toBe('siemens_s7_1500');
    expect(data.target.tia_version).toBe('19');
  });
});

describe('manifest.json — feature flags', () => {
  it('exposes resolved compiler features in snake_case', () => {
    const data = loadManifest();
    expect(data.features).toEqual({
      use_db_alarms: true,
      emit_fb_alarms: true,
      emit_diagnostics_in_manifest: true,
      strict_diagnostics: false,
    });
  });

  it('reflects useDbAlarms=false by removing DB_Alarms / FB_Alarms artifacts', () => {
    const data = loadManifest({
      manifest: CLOCK.manifest,
      features: { useDbAlarms: false },
    });
    expect(data.features.use_db_alarms).toBe(false);
    expect(data.features.emit_fb_alarms).toBe(false);
    expect(data.artifacts).not.toContain('DB_Alarms.scl');
    expect(data.artifacts).not.toContain('FB_Alarms.scl');
  });

  it('emitDiagnosticsInManifest=false strips compiler_diagnostics from the payload', () => {
    const data = loadManifest({
      manifest: CLOCK.manifest,
      features: { emitDiagnosticsInManifest: false },
    });
    expect(data.features.emit_diagnostics_in_manifest).toBe(false);
    expect(data.compiler_diagnostics).toBeUndefined();
  });
});

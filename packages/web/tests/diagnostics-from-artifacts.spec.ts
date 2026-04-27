import { describe, expect, it } from 'vitest';
import type {
  ArtifactDiagnostic,
  GeneratedArtifact,
} from '@plccopilot/codegen-core';
import { diagnosticsFromGeneratedArtifacts } from '../src/utils/diagnostics.js';

function manifest(payload: unknown): GeneratedArtifact {
  return {
    path: 'siemens/manifest.json',
    kind: 'json',
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function scl(
  path: string,
  diagnostics?: readonly ArtifactDiagnostic[],
): GeneratedArtifact {
  return {
    path,
    kind: 'scl',
    content: '(* … *)',
    ...(diagnostics ? { diagnostics: [...diagnostics] } : {}),
  };
}

const SAMPLE_ERROR: ArtifactDiagnostic = {
  code: 'UNKNOWN_FUNCTION',
  severity: 'error',
  message: 'unknown function "x"',
  path: 'machines[0].alarms[0].when',
  symbol: 'al_x',
  hint: 'Fix the alarm condition expression before generating artifacts.',
};

describe('diagnosticsFromGeneratedArtifacts — sprint 44', () => {
  it('returns artifact.diagnostics when there are no manifest diagnostics', () => {
    const artifacts: GeneratedArtifact[] = [scl('siemens/FB_X.scl', [SAMPLE_ERROR])];
    expect(diagnosticsFromGeneratedArtifacts(artifacts)).toEqual([SAMPLE_ERROR]);
  });

  it('parses manifest.compiler_diagnostics and includes them', () => {
    const artifacts: GeneratedArtifact[] = [
      manifest({
        compiler_diagnostics: [
          {
            code: 'TIMEOUT_NO_AUTO_TRANSITION',
            severity: 'info',
            message: 'transition t has timeout but no fault state',
            path: 'machines[0].stations[0].sequence.transitions[0].timeout',
            station_id: 'st_load',
            symbol: 't_load_timeout',
            hint: 'add an explicit transition or accept the alarm-only behavior',
          },
        ],
      }),
    ];
    const out = diagnosticsFromGeneratedArtifacts(artifacts);
    expect(out).toHaveLength(1);
    // station_id (snake) → stationId (camel) — UI consumes camelCase.
    expect(out[0]!.stationId).toBe('st_load');
    expect(out[0]!.symbol).toBe('t_load_timeout');
    expect(out[0]!.path).toContain('sequence.transitions[0].timeout');
  });

  it('dedupes diagnostics that appear on both an artifact and the manifest', () => {
    const dup: ArtifactDiagnostic = SAMPLE_ERROR;
    const artifacts: GeneratedArtifact[] = [
      scl('siemens/FB_X.scl', [dup]),
      manifest({
        compiler_diagnostics: [
          {
            code: dup.code,
            severity: dup.severity,
            message: dup.message,
            path: dup.path,
            symbol: dup.symbol,
            hint: dup.hint,
          },
        ],
      }),
    ];
    const out = diagnosticsFromGeneratedArtifacts(artifacts);
    expect(out).toHaveLength(1);
  });

  it('keeps distinct diagnostics that share code/severity but differ in path', () => {
    const a: ArtifactDiagnostic = { ...SAMPLE_ERROR, path: 'machines[0].alarms[0].when' };
    const b: ArtifactDiagnostic = { ...SAMPLE_ERROR, path: 'machines[0].alarms[1].when' };
    const out = diagnosticsFromGeneratedArtifacts([
      scl('siemens/FB_X.scl', [a, b]),
    ]);
    expect(out).toHaveLength(2);
  });

  it('ignores malformed manifest JSON (rest of pipeline keeps working)', () => {
    const artifacts: GeneratedArtifact[] = [
      scl('siemens/FB_X.scl', [SAMPLE_ERROR]),
      { path: 'siemens/manifest.json', kind: 'json', content: '{ not valid' },
    ];
    const out = diagnosticsFromGeneratedArtifacts(artifacts);
    expect(out).toEqual([SAMPLE_ERROR]);
  });

  it('ignores manifest where compiler_diagnostics is not an array', () => {
    const artifacts: GeneratedArtifact[] = [
      manifest({ compiler_diagnostics: 'oops' }),
    ];
    expect(diagnosticsFromGeneratedArtifacts(artifacts)).toEqual([]);
  });

  it('drops malformed manifest rows but keeps well-formed siblings', () => {
    const artifacts: GeneratedArtifact[] = [
      manifest({
        compiler_diagnostics: [
          { code: 'OK_ONE', severity: 'info', message: 'good' },
          { code: 'BAD' /* missing severity / message */ },
          'completely-not-an-object',
          {
            code: 'OK_TWO',
            severity: 'invalid' /* unknown severity */,
            message: 'bad sev',
          },
          {
            code: 'OK_THREE',
            severity: 'warning',
            message: 'good warn',
          },
        ],
      }),
    ];
    const out = diagnosticsFromGeneratedArtifacts(artifacts);
    expect(out.map((d) => d.code).sort()).toEqual(['OK_ONE', 'OK_THREE']);
  });

  it('does not mutate input artifacts', () => {
    const original: ArtifactDiagnostic[] = [SAMPLE_ERROR];
    const artifacts: GeneratedArtifact[] = [
      { path: 'siemens/FB_X.scl', kind: 'scl', content: '', diagnostics: original },
    ];
    diagnosticsFromGeneratedArtifacts(artifacts);
    expect(artifacts[0]!.diagnostics).toEqual([SAMPLE_ERROR]);
    expect(original).toEqual([SAMPLE_ERROR]);
  });
});

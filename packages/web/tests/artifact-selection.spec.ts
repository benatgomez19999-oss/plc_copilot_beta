import { describe, expect, it } from 'vitest';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { selectBestArtifact } from '../src/utils/artifact-selection.js';

const stub = (path: string): GeneratedArtifact => ({
  path,
  kind: 'st',
  content: '',
});

describe('selectBestArtifact', () => {
  it('returns null for an empty artifact list', () => {
    expect(selectBestArtifact('siemens/FB_StLoad.scl', [])).toBeNull();
    expect(selectBestArtifact(null, [])).toBeNull();
  });

  it('keeps the previous selection when the exact path still exists', () => {
    const arts = [
      stub('siemens/FB_StLoad.scl'),
      stub('siemens/FB_StWeld.scl'),
      stub('siemens/manifest.json'),
    ];
    expect(selectBestArtifact('siemens/FB_StWeld.scl', arts)).toBe(
      'siemens/FB_StWeld.scl',
    );
  });

  it('falls back to the same basename when the backend changed', () => {
    const arts = [
      stub('codesys/FB_StLoad.st'),
      stub('codesys/FB_StWeld.st'),
      stub('codesys/manifest.json'),
    ];
    // User had `siemens/FB_StWeld.scl` selected; now generating Codesys.
    expect(selectBestArtifact('siemens/FB_StWeld.scl', arts)).toBe(
      'codesys/FB_StWeld.st',
    );
  });

  it('prefers the first non-manifest artifact when nothing else matches', () => {
    const arts = [
      stub('rockwell/manifest.json'),
      stub('rockwell/FB_StLoad.st'),
      stub('rockwell/FB_StWeld.st'),
    ];
    expect(selectBestArtifact(null, arts)).toBe('rockwell/FB_StLoad.st');
    expect(selectBestArtifact('does/not/exist.scl', arts)).toBe(
      'rockwell/FB_StLoad.st',
    );
  });

  it('falls back to the first artifact when only manifest exists', () => {
    const arts = [stub('siemens/manifest.json')];
    expect(selectBestArtifact(null, arts)).toBe('siemens/manifest.json');
  });

  it('basename match is exact, not a prefix', () => {
    const arts = [
      stub('codesys/FB_StWeldMore.st'),
      stub('codesys/Other.st'),
    ];
    // No exact basename match for `FB_StWeld` → falls through to first non-manifest.
    expect(selectBestArtifact('siemens/FB_StWeld.scl', arts)).toBe(
      'codesys/FB_StWeldMore.st',
    );
  });

  it('exact-path match wins over basename match in another directory', () => {
    const arts = [
      stub('codesys/FB_StWeld.st'),
      stub('siemens/FB_StWeld.scl'),
    ];
    expect(selectBestArtifact('siemens/FB_StWeld.scl', arts)).toBe(
      'siemens/FB_StWeld.scl',
    );
  });
});

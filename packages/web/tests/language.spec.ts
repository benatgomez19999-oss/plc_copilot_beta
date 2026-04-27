import { describe, expect, it } from 'vitest';
import { detectArtifactLanguage } from '../src/utils/language.js';

describe('detectArtifactLanguage — extension wins', () => {
  it('.scl → scl', () => {
    expect(detectArtifactLanguage('siemens/FB_StLoad.scl', 'scl')).toBe('scl');
  });

  it('.st → structured-text', () => {
    expect(detectArtifactLanguage('codesys/FB_StLoad.st', 'st')).toBe(
      'structured-text',
    );
  });

  it('.json → json', () => {
    expect(detectArtifactLanguage('siemens/manifest.json', 'json')).toBe(
      'json',
    );
  });

  it('.csv → plaintext (no Monaco CSV language registered)', () => {
    expect(detectArtifactLanguage('siemens/Tags_Main.csv', 'csv')).toBe(
      'plaintext',
    );
  });

  it('extension match is case-insensitive', () => {
    expect(detectArtifactLanguage('FOO.SCL', 'scl')).toBe('scl');
    expect(detectArtifactLanguage('Bar.JSON', 'json')).toBe('json');
  });

  it('extension wins over kind when they disagree', () => {
    // Mismatched on purpose — path is the most specific signal.
    expect(detectArtifactLanguage('foo.json', 'scl')).toBe('json');
    expect(detectArtifactLanguage('foo.scl', 'json')).toBe('scl');
  });
});

describe('detectArtifactLanguage — kind fallback', () => {
  it('uses `kind` when the path has no recognised extension', () => {
    expect(detectArtifactLanguage('weird/no_extension', 'scl')).toBe('scl');
    expect(detectArtifactLanguage('weird/no_extension', 'st')).toBe(
      'structured-text',
    );
    expect(detectArtifactLanguage('weird/no_extension', 'json')).toBe('json');
    expect(detectArtifactLanguage('weird/no_extension', 'csv')).toBe(
      'plaintext',
    );
  });

  it('returns plaintext when both path and kind are unrecognised', () => {
    expect(
      detectArtifactLanguage('weird/no_extension', 'unknown' as string),
    ).toBe('plaintext');
    expect(detectArtifactLanguage('', '')).toBe('plaintext');
  });
});

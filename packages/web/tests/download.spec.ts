import { describe, expect, it } from 'vitest';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { buildArtifactsZip } from '../src/utils/download.js';

const sample = (path: string, content = 'x'): GeneratedArtifact => ({
  path,
  kind: 'st',
  content,
});

describe('buildArtifactsZip', () => {
  it('produces one entry per artifact, preserving directory structure', async () => {
    const zip = buildArtifactsZip([
      sample('siemens/FB_StLoad.scl'),
      sample('siemens/manifest.json'),
      sample('codesys/FB_StLoad.st'),
      sample('rockwell/FB_StLoad.st'),
    ]);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      'codesys/FB_StLoad.st',
      'rockwell/FB_StLoad.st',
      'siemens/FB_StLoad.scl',
      'siemens/manifest.json',
    ]);
  });

  it('preserves the artifact content byte-for-byte', async () => {
    const zip = buildArtifactsZip([sample('siemens/A.scl', 'hello\nworld')]);
    const file = zip.file('siemens/A.scl');
    expect(file).not.toBeNull();
    const text = await file!.async('string');
    expect(text).toBe('hello\nworld');
  });

  it('adds summary.json when an options.summary object is provided', () => {
    const zip = buildArtifactsZip([sample('siemens/A.scl')], {
      summary: { backend: 'siemens', artifact_count: 1 },
    });
    expect(zip.file('summary.json')).not.toBeNull();
  });

  it('rejects an absolute artifact path (POSIX)', () => {
    expect(() =>
      buildArtifactsZip([sample('/etc/passwd', 'pwned')]),
    ).toThrow(/unsafe artifact path/);
  });

  it('rejects an absolute artifact path (Windows)', () => {
    expect(() =>
      buildArtifactsZip([sample('C:\\Windows\\System32\\evil.bat', 'pwned')]),
    ).toThrow(/unsafe artifact path/);
  });

  it('rejects path traversal via `..`', () => {
    expect(() =>
      buildArtifactsZip([sample('../escape.txt', 'pwned')]),
    ).toThrow(/unsafe artifact path/);
  });

  it('rejects nested traversal (`siemens/../etc/passwd`)', () => {
    expect(() =>
      buildArtifactsZip([sample('siemens/../etc/passwd', 'pwned')]),
    ).toThrow(/unsafe artifact path/);
  });

  it('rejects empty paths', () => {
    expect(() => buildArtifactsZip([sample('', 'x')])).toThrow(
      /unsafe artifact path/,
    );
  });

  it('allows nested safe paths (e.g. siemens/sub/dir/file.scl)', () => {
    expect(() =>
      buildArtifactsZip([sample('siemens/sub/dir/file.scl')]),
    ).not.toThrow();
  });
});

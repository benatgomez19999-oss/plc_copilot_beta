import { describe, expect, it } from 'vitest';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import {
  findPreviousArtifact,
  hasContentChanged,
} from '../src/utils/artifact-diff.js';

const make = (path: string, content: string): GeneratedArtifact => ({
  path,
  kind: 'st',
  content,
});

describe('findPreviousArtifact', () => {
  it('returns the artifact with an exact path match', () => {
    const list = [
      make('siemens/FB_StLoad.scl', 'one'),
      make('siemens/FB_StWeld.scl', 'two'),
      make('siemens/manifest.json', '{}'),
    ];
    const found = findPreviousArtifact('siemens/FB_StWeld.scl', list);
    expect(found).not.toBeNull();
    expect(found!.content).toBe('two');
  });

  it('returns null when no entry matches the path', () => {
    const list = [
      make('siemens/FB_StLoad.scl', 'one'),
      make('siemens/FB_StWeld.scl', 'two'),
    ];
    expect(findPreviousArtifact('codesys/FB_StLoad.st', list)).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(findPreviousArtifact('siemens/FB_StLoad.scl', [])).toBeNull();
  });

  it('match is exact — basename collision across backends does NOT match', () => {
    // The same basename in a different directory must not be returned —
    // diff is exact-path only by spec.
    const list = [make('codesys/FB_StLoad.st', 'codesys-content')];
    expect(findPreviousArtifact('siemens/FB_StLoad.scl', list)).toBeNull();
  });

  it('returns the first match (stable behaviour) when duplicates exist', () => {
    // Real codegen never produces duplicate paths, but the helper is
    // robust either way: scan order is preserved.
    const list = [
      make('siemens/x.scl', 'first'),
      make('siemens/x.scl', 'second'),
    ];
    expect(findPreviousArtifact('siemens/x.scl', list)!.content).toBe('first');
  });
});

describe('hasContentChanged', () => {
  it('false when contents are byte-identical', () => {
    expect(
      hasContentChanged(
        make('p', 'FUNCTION_BLOCK X\nEND_FUNCTION_BLOCK\n'),
        make('p', 'FUNCTION_BLOCK X\nEND_FUNCTION_BLOCK\n'),
      ),
    ).toBe(false);
  });

  it('true when contents differ in any byte', () => {
    expect(
      hasContentChanged(make('p', 'a'), make('p', 'b')),
    ).toBe(true);
  });

  it('true when only whitespace differs (strict compare)', () => {
    expect(
      hasContentChanged(make('p', 'a'), make('p', 'a ')),
    ).toBe(true);
  });

  it('true when one is empty and the other is not', () => {
    expect(
      hasContentChanged(make('p', ''), make('p', 'x')),
    ).toBe(true);
  });

  it('false on two empty strings', () => {
    expect(
      hasContentChanged(make('p', ''), make('p', '')),
    ).toBe(false);
  });
});

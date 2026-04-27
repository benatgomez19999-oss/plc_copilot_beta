import { describe, expect, it } from 'vitest';
import {
  clampEditorLine,
  focusToneClassSuffix,
  type FocusHighlightTone,
} from '../src/utils/monaco-focus.js';

describe('clampEditorLine — invalid line numbers fall back to 1', () => {
  it('null → 1', () => {
    expect(clampEditorLine(null, 100)).toBe(1);
  });
  it('undefined → 1', () => {
    expect(clampEditorLine(undefined, 100)).toBe(1);
  });
  it('NaN → 1', () => {
    expect(clampEditorLine(Number.NaN, 100)).toBe(1);
  });
  it('Infinity → 1', () => {
    expect(clampEditorLine(Number.POSITIVE_INFINITY, 100)).toBe(1);
  });
  it('-Infinity → 1', () => {
    expect(clampEditorLine(Number.NEGATIVE_INFINITY, 100)).toBe(1);
  });
});

describe('clampEditorLine — out-of-range values', () => {
  it('zero → 1 (Monaco uses 1-based line numbering)', () => {
    expect(clampEditorLine(0, 100)).toBe(1);
  });
  it('negative → 1', () => {
    expect(clampEditorLine(-5, 100)).toBe(1);
  });
  it('past the last line clamps down to lineCount', () => {
    expect(clampEditorLine(500, 100)).toBe(100);
  });
});

describe('clampEditorLine — valid input passes through', () => {
  it('first line', () => {
    expect(clampEditorLine(1, 100)).toBe(1);
  });
  it('last line', () => {
    expect(clampEditorLine(100, 100)).toBe(100);
  });
  it('middle', () => {
    expect(clampEditorLine(42, 100)).toBe(42);
  });
  it('floors fractional inputs', () => {
    expect(clampEditorLine(3.7, 100)).toBe(3);
  });
});

describe('clampEditorLine — degenerate lineCount', () => {
  it('lineCount === 0 still produces line 1 (single-line model)', () => {
    expect(clampEditorLine(1, 0)).toBe(1);
    expect(clampEditorLine(5, 0)).toBe(1);
  });
  it('negative lineCount falls back to 1', () => {
    expect(clampEditorLine(1, -10)).toBe(1);
  });
  it('non-finite lineCount falls back to 1', () => {
    expect(clampEditorLine(1, Number.NaN)).toBe(1);
    expect(clampEditorLine(1, Number.POSITIVE_INFINITY)).toBe(1);
  });
  it('fractional lineCount is floored', () => {
    expect(clampEditorLine(99, 10.9)).toBe(10);
  });
});

// =============================================================================
// focusToneClassSuffix (sprint 29)
// =============================================================================

describe('focusToneClassSuffix — known tones', () => {
  it('"neutral" returns the empty string (no suffix)', () => {
    expect(focusToneClassSuffix('neutral')).toBe('');
  });

  it('"error" returns "-error"', () => {
    expect(focusToneClassSuffix('error')).toBe('-error');
  });

  it('"warning" returns "-warning"', () => {
    expect(focusToneClassSuffix('warning')).toBe('-warning');
  });

  it('"info" returns "-info"', () => {
    expect(focusToneClassSuffix('info')).toBe('-info');
  });
});

describe('focusToneClassSuffix — defensive cases', () => {
  it('null returns the empty string', () => {
    expect(focusToneClassSuffix(null)).toBe('');
  });

  it('undefined returns the empty string', () => {
    expect(focusToneClassSuffix(undefined)).toBe('');
  });

  it('an unknown value (defensive cast) returns the empty string', () => {
    // A future caller passing an unrecognised string must NOT crash the
    // editor — it should fall through to the neutral palette.
    expect(
      focusToneClassSuffix(
        'unknown-severity' as unknown as FocusHighlightTone,
      ),
    ).toBe('');
    expect(
      focusToneClassSuffix(42 as unknown as FocusHighlightTone),
    ).toBe('');
  });
});

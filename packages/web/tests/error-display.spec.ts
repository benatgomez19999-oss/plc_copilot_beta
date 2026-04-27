import { describe, expect, it } from 'vitest';
import {
  hasErrorCodePrefix,
  isPirJsonPath,
  splitErrorCodePrefix,
} from '../src/utils/error-display.js';

describe('hasErrorCodePrefix', () => {
  it('matches `[UPPER_SNAKE]` followed by whitespace', () => {
    expect(hasErrorCodePrefix('[UNKNOWN_PARAMETER] Recipe …')).toBe(true);
    expect(hasErrorCodePrefix('[NO_MACHINE] no machine')).toBe(true);
    expect(hasErrorCodePrefix('[X] x')).toBe(true);
  });

  it('rejects mixed case / lowercase / hyphen / non-bracket prefixes', () => {
    expect(hasErrorCodePrefix('[unknown_parameter] msg')).toBe(false);
    expect(hasErrorCodePrefix('[MIXED_Case] msg')).toBe(false);
    expect(hasErrorCodePrefix('[HAS-DASH] msg')).toBe(false);
    expect(hasErrorCodePrefix('error: plain')).toBe(false);
    expect(hasErrorCodePrefix('TypeError: bad arg')).toBe(false);
  });

  it('rejects bracket-prefix without trailing whitespace', () => {
    expect(hasErrorCodePrefix('[CODE]message')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(hasErrorCodePrefix('')).toBe(false);
  });
});

describe('splitErrorCodePrefix', () => {
  it('extracts code + rest when prefix is present', () => {
    expect(
      splitErrorCodePrefix(
        '[UNKNOWN_PARAMETER] Recipe "r" references unknown parameter "p".',
      ),
    ).toEqual({
      code: 'UNKNOWN_PARAMETER',
      rest: 'Recipe "r" references unknown parameter "p".',
    });
  });

  it('preserves trailing metadata segments verbatim', () => {
    const out = splitErrorCodePrefix(
      '[UNKNOWN_IO] missing IO (path: machines[0]) Hint: check binding',
    );
    expect(out.code).toBe('UNKNOWN_IO');
    expect(out.rest).toBe(
      'missing IO (path: machines[0]) Hint: check binding',
    );
  });

  it('returns rest = full message when no prefix', () => {
    expect(splitErrorCodePrefix('TypeError: bad arg')).toEqual({
      rest: 'TypeError: bad arg',
    });
  });

  it('survives multiline messages (debug stack appended)', () => {
    const msg = '[X] m\nError: m\n    at foo()';
    const out = splitErrorCodePrefix(msg);
    expect(out.code).toBe('X');
    expect(out.rest).toBe('m\nError: m\n    at foo()');
  });
});

describe('isPirJsonPath — sprint 43', () => {
  it('accepts bracket-indexed PIR paths', () => {
    expect(isPirJsonPath('machines[0]')).toBe(true);
    expect(isPirJsonPath('machines[0].stations[0]')).toBe(true);
    expect(
      isPirJsonPath(
        'machines[0].stations[0].sequence.transitions[2].guard',
      ),
    ).toBe(true);
    expect(isPirJsonPath('machines[0].interlocks[1].when')).toBe(true);
    expect(isPirJsonPath('machines[12]')).toBe(true);
  });

  it('accepts root `$`', () => {
    expect(isPirJsonPath('$')).toBe(true);
  });

  it('rejects logical FB-name placeholders', () => {
    expect(isPirJsonPath('FB_StLoad')).toBe(false);
    expect(isPirJsonPath('FB_Alarms')).toBe(false);
  });

  it('rejects empty / null / undefined', () => {
    expect(isPirJsonPath('')).toBe(false);
    expect(isPirJsonPath(null)).toBe(false);
    expect(isPirJsonPath(undefined)).toBe(false);
  });

  it('rejects non-bracket-indexed strings', () => {
    expect(isPirJsonPath('machines.0.stations')).toBe(false);
    expect(isPirJsonPath('foo')).toBe(false);
    expect(isPirJsonPath('machines[a]')).toBe(false);
    expect(isPirJsonPath('machines[]')).toBe(false);
  });
});

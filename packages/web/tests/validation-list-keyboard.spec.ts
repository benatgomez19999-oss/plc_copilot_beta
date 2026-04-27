import { describe, expect, it } from 'vitest';
import { nextIssueRowIndex } from '../src/utils/validation-list-keyboard.js';

// =============================================================================
// nextIssueRowIndex (sprint 32)
// =============================================================================

describe('nextIssueRowIndex — empty list', () => {
  it('1. returns null whatever the direction when count is 0', () => {
    expect(nextIssueRowIndex(0, 0, 'next')).toBeNull();
    expect(nextIssueRowIndex(-1, 0, 'prev')).toBeNull();
    expect(nextIssueRowIndex(0, 0, 'first')).toBeNull();
    expect(nextIssueRowIndex(0, 0, 'last')).toBeNull();
  });

  it('1b. negative counts are also treated as empty', () => {
    expect(nextIssueRowIndex(0, -3, 'next')).toBeNull();
  });
});

describe('nextIssueRowIndex — wrapping', () => {
  it('2. next wraps from last back to first', () => {
    expect(nextIssueRowIndex(4, 5, 'next')).toBe(0);
  });

  it('3. prev wraps from first back to last', () => {
    expect(nextIssueRowIndex(0, 5, 'prev')).toBe(4);
  });

  it('3b. next / prev step linearly through the middle', () => {
    expect(nextIssueRowIndex(2, 5, 'next')).toBe(3);
    expect(nextIssueRowIndex(2, 5, 'prev')).toBe(1);
  });
});

describe('nextIssueRowIndex — Home / End', () => {
  it('4. first returns 0 regardless of current', () => {
    expect(nextIssueRowIndex(0, 5, 'first')).toBe(0);
    expect(nextIssueRowIndex(2, 5, 'first')).toBe(0);
    expect(nextIssueRowIndex(-1, 5, 'first')).toBe(0);
  });

  it('5. last returns count - 1 regardless of current', () => {
    expect(nextIssueRowIndex(0, 5, 'last')).toBe(4);
    expect(nextIssueRowIndex(2, 5, 'last')).toBe(4);
    expect(nextIssueRowIndex(-1, 5, 'last')).toBe(4);
  });
});

describe('nextIssueRowIndex — no row currently focused (current = -1)', () => {
  it('6. next falls through to the first row', () => {
    expect(nextIssueRowIndex(-1, 5, 'next')).toBe(0);
  });

  it('7. prev falls through to the last row', () => {
    expect(nextIssueRowIndex(-1, 5, 'prev')).toBe(4);
  });
});

describe('nextIssueRowIndex — single-row list', () => {
  it('8. count of 1 wraps to itself for both next and prev', () => {
    expect(nextIssueRowIndex(0, 1, 'next')).toBe(0);
    expect(nextIssueRowIndex(0, 1, 'prev')).toBe(0);
    expect(nextIssueRowIndex(0, 1, 'first')).toBe(0);
    expect(nextIssueRowIndex(0, 1, 'last')).toBe(0);
  });
});

describe('nextIssueRowIndex — out-of-range current', () => {
  it('9. tolerates a current >= count by treating modular arithmetic', () => {
    // If a row index becomes stale (e.g. filter shrunk the list while
    // focus was on an index that no longer exists), the helper should
    // still produce a valid in-range result rather than crashing.
    expect(nextIssueRowIndex(7, 5, 'next')).toBe(3); // (7+1)%5 = 3
    expect(nextIssueRowIndex(7, 5, 'prev')).toBe(1); // (7-1+5)%5 = 11%5 = 1
  });
});

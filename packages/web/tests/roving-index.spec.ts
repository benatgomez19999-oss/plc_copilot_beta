import { describe, expect, it } from 'vitest';
import {
  clampRovingIndex,
  nextRovingIndex,
} from '../src/utils/roving-index.js';

// =============================================================================
// nextRovingIndex
// =============================================================================

describe('nextRovingIndex — empty / negative count', () => {
  it('1. count of 0 returns null for every direction', () => {
    expect(nextRovingIndex(0, 0, 'next')).toBeNull();
    expect(nextRovingIndex(-1, 0, 'prev')).toBeNull();
    expect(nextRovingIndex(0, 0, 'first')).toBeNull();
    expect(nextRovingIndex(0, 0, 'last')).toBeNull();
  });

  it('2. negative counts are also treated as empty', () => {
    expect(nextRovingIndex(0, -3, 'next')).toBeNull();
    expect(nextRovingIndex(0, -1, 'first')).toBeNull();
  });
});

describe('nextRovingIndex — wrapping', () => {
  it('3. next from middle returns middle + 1', () => {
    expect(nextRovingIndex(2, 5, 'next')).toBe(3);
  });

  it('4. prev from middle returns middle - 1', () => {
    expect(nextRovingIndex(2, 5, 'prev')).toBe(1);
  });

  it('5. next wraps last → first', () => {
    expect(nextRovingIndex(4, 5, 'next')).toBe(0);
  });

  it('6. prev wraps first → last', () => {
    expect(nextRovingIndex(0, 5, 'prev')).toBe(4);
  });
});

describe('nextRovingIndex — Home / End', () => {
  it('7. first returns 0 regardless of current', () => {
    expect(nextRovingIndex(2, 5, 'first')).toBe(0);
    expect(nextRovingIndex(-1, 5, 'first')).toBe(0);
    expect(nextRovingIndex(99, 5, 'first')).toBe(0);
  });

  it('8. last returns count - 1 regardless of current', () => {
    expect(nextRovingIndex(0, 5, 'last')).toBe(4);
    expect(nextRovingIndex(-1, 5, 'last')).toBe(4);
    expect(nextRovingIndex(99, 5, 'last')).toBe(4);
  });
});

describe('nextRovingIndex — current = -1 (no item active)', () => {
  it('9. next falls through to first', () => {
    expect(nextRovingIndex(-1, 5, 'next')).toBe(0);
  });

  it('10. prev falls through to last', () => {
    expect(nextRovingIndex(-1, 5, 'prev')).toBe(4);
  });
});

describe('nextRovingIndex — single-item list', () => {
  it('11. count of 1 wraps to itself for next / prev / first / last', () => {
    expect(nextRovingIndex(0, 1, 'next')).toBe(0);
    expect(nextRovingIndex(0, 1, 'prev')).toBe(0);
    expect(nextRovingIndex(0, 1, 'first')).toBe(0);
    expect(nextRovingIndex(0, 1, 'last')).toBe(0);
  });
});

describe('nextRovingIndex — out-of-range current (defensive)', () => {
  it('12. modular fallback for current >= count', () => {
    expect(nextRovingIndex(7, 5, 'next')).toBe(3); // (7+1)%5 = 3
    expect(nextRovingIndex(7, 5, 'prev')).toBe(1); // (7-1)%5 = 1 (positive modulo)
  });
});

// =============================================================================
// clampRovingIndex
// =============================================================================

describe('clampRovingIndex — empty / non-positive count', () => {
  it('13. count of 0 returns 0 regardless of current', () => {
    expect(clampRovingIndex(0, 0)).toBe(0);
    expect(clampRovingIndex(5, 0)).toBe(0);
    expect(clampRovingIndex(-3, 0)).toBe(0);
  });

  it('14. negative count returns 0', () => {
    expect(clampRovingIndex(0, -2)).toBe(0);
  });
});

describe('clampRovingIndex — clamping', () => {
  it('15. negative current clamps to 0', () => {
    expect(clampRovingIndex(-5, 10)).toBe(0);
  });

  it('16. current >= count clamps to count - 1', () => {
    expect(clampRovingIndex(99, 10)).toBe(9);
    expect(clampRovingIndex(10, 10)).toBe(9);
  });

  it('17. valid current passes through', () => {
    expect(clampRovingIndex(0, 10)).toBe(0);
    expect(clampRovingIndex(5, 10)).toBe(5);
    expect(clampRovingIndex(9, 10)).toBe(9);
  });
});

describe('clampRovingIndex — defensive numerics', () => {
  it('18. NaN current returns 0', () => {
    expect(clampRovingIndex(Number.NaN, 10)).toBe(0);
  });

  it('18b. ±Infinity current returns 0', () => {
    expect(clampRovingIndex(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampRovingIndex(Number.NEGATIVE_INFINITY, 10)).toBe(0);
  });

  it('18c. fractional current is floored', () => {
    expect(clampRovingIndex(3.7, 10)).toBe(3);
    expect(clampRovingIndex(0.999, 10)).toBe(0);
  });
});

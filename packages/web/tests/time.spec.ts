import { describe, expect, it } from 'vitest';
import {
  formatRelativeAge,
  isOlderThanMs,
  parseIsoTimeMs,
} from '../src/utils/time.js';

describe('parseIsoTimeMs', () => {
  it('1. parses a well-formed ISO timestamp', () => {
    const iso = '2026-04-26T10:00:00.000Z';
    expect(parseIsoTimeMs(iso)).toBe(Date.parse(iso));
  });

  it('2. returns null for null / undefined / empty / non-string input', () => {
    expect(parseIsoTimeMs(null)).toBeNull();
    expect(parseIsoTimeMs(undefined)).toBeNull();
    expect(parseIsoTimeMs('')).toBeNull();
    // The signature is typed but we still defend against runtime garbage.
    expect(parseIsoTimeMs(42 as unknown as string)).toBeNull();
  });

  it('3. returns null when Date.parse cannot decode the string', () => {
    expect(parseIsoTimeMs('not-a-date')).toBeNull();
    expect(parseIsoTimeMs('2026-13-99T99:99:99Z')).toBeNull();
  });
});

describe('formatRelativeAge', () => {
  const now = Date.parse('2026-04-26T10:00:00.000Z');

  it('4. < 60 seconds → "just now"', () => {
    expect(formatRelativeAge(now, now)).toBe('just now');
    expect(formatRelativeAge(now, now - 1_000)).toBe('just now');
    expect(formatRelativeAge(now, now - 59_999)).toBe('just now');
  });

  it('5. < 60 minutes → "N min ago" (floored)', () => {
    expect(formatRelativeAge(now, now - 60_000)).toBe('1 min ago');
    expect(formatRelativeAge(now, now - 5 * 60_000)).toBe('5 min ago');
    expect(formatRelativeAge(now, now - 59 * 60_000)).toBe('59 min ago');
  });

  it('6. < 24 hours → "N h ago" (floored)', () => {
    expect(formatRelativeAge(now, now - 60 * 60_000)).toBe('1 h ago');
    expect(formatRelativeAge(now, now - 12 * 60 * 60_000)).toBe('12 h ago');
    expect(formatRelativeAge(now, now - 23 * 60 * 60_000)).toBe('23 h ago');
  });

  it('7. >= 24 hours → "N d ago" (floored)', () => {
    expect(formatRelativeAge(now, now - 24 * 60 * 60_000)).toBe('1 d ago');
    expect(formatRelativeAge(now, now - 7 * 24 * 60 * 60_000)).toBe('7 d ago');
    expect(formatRelativeAge(now, now - 365 * 24 * 60 * 60_000)).toBe(
      '365 d ago',
    );
  });

  it('8. future timestamp (then > now) renders as "just now"', () => {
    // diffMs is negative which is < 60_000, so the leading branch fires.
    expect(formatRelativeAge(now, now + 5_000)).toBe('just now');
    expect(formatRelativeAge(now, now + 60 * 60_000)).toBe('just now');
  });

  it('9. NaN inputs degrade to "just now" (defensive)', () => {
    expect(formatRelativeAge(Number.NaN, now)).toBe('just now');
    expect(formatRelativeAge(now, Number.NaN)).toBe('just now');
    expect(formatRelativeAge(Number.POSITIVE_INFINITY, now)).toBe('just now');
  });
});

describe('isOlderThanMs', () => {
  const now = 1_000_000;
  const ONE_DAY = 24 * 60 * 60 * 1_000;

  it('10. fresh entry (within window) → false', () => {
    expect(isOlderThanMs(now, now - 1_000, ONE_DAY)).toBe(false);
    expect(isOlderThanMs(now, now - ONE_DAY + 1, ONE_DAY)).toBe(false);
  });

  it('11. boundary equality (diff == max) is NOT stale', () => {
    // The contract is `> max`, so exactly at the boundary the entry is
    // still treated as fresh.
    expect(isOlderThanMs(now, now - ONE_DAY, ONE_DAY)).toBe(false);
  });

  it('12. older than window → true', () => {
    expect(isOlderThanMs(now, now - ONE_DAY - 1, ONE_DAY)).toBe(true);
    expect(isOlderThanMs(now, now - 7 * ONE_DAY, ONE_DAY)).toBe(true);
  });

  it('13. future timestamp (now < then) → false (not stale)', () => {
    // Clock skew between save and load is tolerated.
    expect(isOlderThanMs(now, now + 1, ONE_DAY)).toBe(false);
    expect(isOlderThanMs(now, now + 10 * ONE_DAY, ONE_DAY)).toBe(false);
  });

  it('14. non-finite inputs / non-positive maxAge → true (defensive stale)', () => {
    expect(isOlderThanMs(Number.NaN, now, ONE_DAY)).toBe(true);
    expect(isOlderThanMs(now, Number.NaN, ONE_DAY)).toBe(true);
    expect(isOlderThanMs(now, now, Number.NaN)).toBe(true);
    expect(isOlderThanMs(now, now, 0)).toBe(true);
    expect(isOlderThanMs(now, now, -1)).toBe(true);
    expect(isOlderThanMs(Number.POSITIVE_INFINITY, now, ONE_DAY)).toBe(true);
  });
});

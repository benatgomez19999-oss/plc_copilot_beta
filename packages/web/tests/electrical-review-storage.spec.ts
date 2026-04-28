// Sprint 78B — defensive localStorage tests for the electrical-review
// session slot. Mirrors the patterns already used in `storage.spec.ts`
// (memory storage, throwing storage, JSON corruption, schema drift).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ELECTRICAL_REVIEW_STORAGE_KEY,
  clearLatestElectricalReviewSession,
  loadLatestElectricalReviewSession,
  saveElectricalReviewSession,
} from '../src/utils/electrical-review-storage.js';
import {
  createReviewSessionSnapshot,
  type ElectricalReviewSessionSnapshot,
} from '../src/utils/electrical-review-session.js';
import { SAMPLE_REVIEW_CANDIDATE } from '../src/utils/review-fixtures.js';
import { createInitialReviewState } from '../src/utils/review-state.js';

const NOW = '2026-04-28T12:00:00.000Z';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function freshSnapshot(): ElectricalReviewSessionSnapshot {
  return createReviewSessionSnapshot({
    source: {
      sourceId: 'src-1',
      fileName: 'terminals.csv',
      inputKind: 'csv',
      sourceKind: 'csv',
      contentHash: 'abc12345',
    },
    candidate: SAMPLE_REVIEW_CANDIDATE,
    reviewState: createInitialReviewState(SAMPLE_REVIEW_CANDIDATE),
    ingestionDiagnostics: [],
    nowIso: NOW,
  });
}

describe('electrical-review-storage — happy path', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. saves and loads the latest snapshot round-trip', () => {
    saveElectricalReviewSession(freshSnapshot());
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.source.fileName).toBe('terminals.csv');
    expect(r.snapshot.schemaVersion).toBe('electrical-review-session.v1');
  });

  it('2. clear removes the entry', () => {
    saveElectricalReviewSession(freshSnapshot());
    clearLatestElectricalReviewSession();
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no saved review session');
  });

  it('3. returns "no saved review session" when nothing is stored', () => {
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no saved review session');
  });

  it('4. last save wins (single-slot v0)', () => {
    saveElectricalReviewSession(freshSnapshot());
    const second = createReviewSessionSnapshot({
      source: {
        sourceId: 'src-2',
        fileName: 'plan.xml',
        inputKind: 'xml',
      },
      candidate: SAMPLE_REVIEW_CANDIDATE,
      reviewState: createInitialReviewState(SAMPLE_REVIEW_CANDIDATE),
      ingestionDiagnostics: [],
      nowIso: NOW,
    });
    saveElectricalReviewSession(second);
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.source.sourceId).toBe('src-2');
  });
});

describe('electrical-review-storage — corrupted / wrong-shape entries', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. invalid JSON clears + returns failure', () => {
    storage.setItem(ELECTRICAL_REVIEW_STORAGE_KEY, '{ not json');
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invalid JSON/);
    expect(storage.getItem(ELECTRICAL_REVIEW_STORAGE_KEY)).toBeNull();
  });

  it('2. wrong schemaVersion clears + returns failure', () => {
    storage.setItem(
      ELECTRICAL_REVIEW_STORAGE_KEY,
      JSON.stringify({
        ...freshSnapshot(),
        schemaVersion: 'electrical-review-session.v0',
      }),
    );
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/schemaVersion/);
    expect(storage.getItem(ELECTRICAL_REVIEW_STORAGE_KEY)).toBeNull();
  });

  it('3. missing required fields clears + returns failure', () => {
    storage.setItem(
      ELECTRICAL_REVIEW_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 'electrical-review-session.v1' }),
    );
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    expect(storage.getItem(ELECTRICAL_REVIEW_STORAGE_KEY)).toBeNull();
  });

  it('4. malformed candidate clears + returns failure', () => {
    const bad = freshSnapshot() as ElectricalReviewSessionSnapshot & {
      candidate: { io: unknown };
    };
    bad.candidate = { io: 'oops' as unknown as never } as never;
    storage.setItem(ELECTRICAL_REVIEW_STORAGE_KEY, JSON.stringify(bad));
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    expect(storage.getItem(ELECTRICAL_REVIEW_STORAGE_KEY)).toBeNull();
  });

  it('5. saving a wrong-schemaVersion snapshot is silently ignored', () => {
    saveElectricalReviewSession({
      ...freshSnapshot(),
      schemaVersion: 'v0' as 'electrical-review-session.v1',
    });
    expect(storage.getItem(ELECTRICAL_REVIEW_STORAGE_KEY)).toBeNull();
  });
});

describe('electrical-review-storage — graceful degradation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. returns "browser storage is unavailable" when localStorage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unavailable/);
  });

  it('2. save does not throw when setItem rejects (quota / security)', () => {
    const throwing: Storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => saveElectricalReviewSession(freshSnapshot())).not.toThrow();
  });

  it('3. load returns failure when getItem throws', () => {
    const throwing: Storage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    const r = loadLatestElectricalReviewSession();
    expect(r.ok).toBe(false);
  });

  it('4. clear does not throw when removeItem rejects', () => {
    const throwing: Storage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error('Quota exceeded');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => clearLatestElectricalReviewSession()).not.toThrow();
  });
});

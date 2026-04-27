import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import type { ValidationReport } from '@plccopilot/pir';
import {
  OPEN_VALIDATION_PANEL_STORAGE_KEY_PREFIX,
  STORAGE_KEY,
  VALIDATION_FILTER_STORAGE_KEY,
  VALIDATION_REPORT_MAX_AGE_MS,
  VALIDATION_REPORT_STORAGE_KEY_PREFIX,
  clearOpenValidationPanel,
  clearSavedProject,
  clearValidationReport,
  loadOpenValidationPanel,
  loadSavedProject,
  loadValidationIssueFilter,
  loadValidationReport,
  saveOpenValidationPanel,
  saveProject,
  saveValidationIssueFilter,
  saveValidationReport,
} from '../src/utils/storage.js';

function fixtureProject(): Project {
  return structuredClone(fixture) as unknown as Project;
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  return storage;
}

describe('storage — happy path', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips fileName + project + loadedAt', () => {
    saveProject('weldline.json', fixtureProject());
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.saved.fileName).toBe('weldline.json');
    expect(typeof loaded.saved.loadedAt).toBe('string');
    expect(loaded.project.id).toBe('prj_weldline');
  });

  it('clearSavedProject removes the entry', () => {
    saveProject('weldline.json', fixtureProject());
    clearSavedProject();
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toBe('no saved project');
  });

  it('returns "no saved project" reason when nothing is stored', () => {
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toBe('no saved project');
  });
});

describe('storage — corrupted entries are auto-cleared', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns failure + clears entry when stored payload is not JSON', () => {
    storage.setItem(STORAGE_KEY, '{ this is not json');
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/invalid JSON/);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('returns failure + clears entry when shape is wrong', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ unrelated: 'shape' }));
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/invalid shape/);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('returns failure + clears entry when projectJson does not match PIR schema', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fileName: 'broken.json',
        loadedAt: new Date().toISOString(),
        projectJson: { foo: 'bar' },
      }),
    );
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/no longer matches PIR/);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('storage — graceful degradation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "browser storage is unavailable" when localStorage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toMatch(/unavailable/);
  });

  it('saveProject does not throw when setItem rejects (quota / security)', () => {
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
    expect(() =>
      saveProject('weldline.json', fixtureProject()),
    ).not.toThrow();
  });

  it('loadSavedProject does not throw when getItem rejects', () => {
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
    const loaded = loadSavedProject();
    expect(loaded.ok).toBe(false);
  });
});

// =============================================================================
// Sprint 32 — validation issue filter persistence
// =============================================================================

describe('validation issue filter storage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. load defaults to "all" when nothing has been saved', () => {
    expect(loadValidationIssueFilter()).toBe('all');
  });

  it('2. saves and loads "all" round-trip', () => {
    saveValidationIssueFilter('all');
    expect(loadValidationIssueFilter()).toBe('all');
  });

  it('3. saves and loads "error" round-trip', () => {
    saveValidationIssueFilter('error');
    expect(loadValidationIssueFilter()).toBe('error');
  });

  it('4. saves and loads "warning" round-trip', () => {
    saveValidationIssueFilter('warning');
    expect(loadValidationIssueFilter()).toBe('warning');
  });

  it('5. saves and loads "info" round-trip', () => {
    saveValidationIssueFilter('info');
    expect(loadValidationIssueFilter()).toBe('info');
  });

  it('6. invalid stored value falls back to "all"', () => {
    // A value outside the union — could come from a future schema
    // change downgrading the runtime, or a hand-poked entry in DevTools.
    localStorage.setItem(VALIDATION_FILTER_STORAGE_KEY, 'critical');
    expect(loadValidationIssueFilter()).toBe('all');
  });

  it('6b. empty string also falls back to "all"', () => {
    localStorage.setItem(VALIDATION_FILTER_STORAGE_KEY, '');
    expect(loadValidationIssueFilter()).toBe('all');
  });

  it('7. unavailable storage (getItem throws) falls back to "all"', () => {
    const throwing: Storage = {
      getItem: () => {
        throw new Error('Storage disabled');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(loadValidationIssueFilter()).toBe('all');
  });

  it('8. save swallows quota / privacy-mode errors and never throws', () => {
    const throwing: Storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => saveValidationIssueFilter('error')).not.toThrow();
  });
});

// =============================================================================
// Sprint 33 / 34 — open ValidationIssuesList panel persistence
// (project-scoped under sprint 34)
// =============================================================================

const PROJECT_A = 'prj_a';
const PROJECT_B = 'prj_b';

function openPanelKey(projectId: string): string {
  return `${OPEN_VALIDATION_PANEL_STORAGE_KEY_PREFIX}${projectId}`;
}

describe('open validation panel storage (project-scoped)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. saves and loads a nodePath round-trip for one project', () => {
    saveOpenValidationPanel(
      PROJECT_A,
      '$.machines[0].stations[0].equipment[0]',
    );
    expect(loadOpenValidationPanel(PROJECT_A)).toEqual({
      projectId: PROJECT_A,
      nodePath: '$.machines[0].stations[0].equipment[0]',
    });
  });

  it('2. project B does not read project A entry', () => {
    saveOpenValidationPanel(PROJECT_A, '$.machines[0]');
    expect(loadOpenValidationPanel(PROJECT_B)).toBeNull();
    // A still loads its own entry untouched.
    expect(loadOpenValidationPanel(PROJECT_A)).toEqual({
      projectId: PROJECT_A,
      nodePath: '$.machines[0]',
    });
  });

  it('3. null clears only the requested project', () => {
    saveOpenValidationPanel(PROJECT_A, '$.machines[0]');
    saveOpenValidationPanel(PROJECT_B, '$.machines[1]');
    saveOpenValidationPanel(PROJECT_A, null);
    expect(loadOpenValidationPanel(PROJECT_A)).toBeNull();
    expect(loadOpenValidationPanel(PROJECT_B)).toEqual({
      projectId: PROJECT_B,
      nodePath: '$.machines[1]',
    });
  });

  it('4. clearOpenValidationPanel removes only that project', () => {
    saveOpenValidationPanel(PROJECT_A, '$.machines[0]');
    saveOpenValidationPanel(PROJECT_B, '$.machines[1]');
    clearOpenValidationPanel(PROJECT_A);
    expect(loadOpenValidationPanel(PROJECT_A)).toBeNull();
    expect(loadOpenValidationPanel(PROJECT_B)).not.toBeNull();
  });

  it('5. invalid JSON clears the entry and returns null', () => {
    localStorage.setItem(openPanelKey(PROJECT_A), 'not-valid-json{');
    expect(loadOpenValidationPanel(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(openPanelKey(PROJECT_A))).toBeNull();
  });

  it('6. payload `projectId` mismatch clears + returns null', () => {
    localStorage.setItem(
      openPanelKey(PROJECT_A),
      JSON.stringify({ projectId: 'someone-else', nodePath: '$.x' }),
    );
    expect(loadOpenValidationPanel(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(openPanelKey(PROJECT_A))).toBeNull();
  });

  it('7. empty-string nodePath returns null and `save("", "")` clears', () => {
    localStorage.setItem(
      openPanelKey(PROJECT_A),
      JSON.stringify({ projectId: PROJECT_A, nodePath: '' }),
    );
    expect(loadOpenValidationPanel(PROJECT_A)).toBeNull();
    saveOpenValidationPanel(PROJECT_A, '');
    expect(localStorage.getItem(openPanelKey(PROJECT_A))).toBeNull();
  });

  it('8. unavailable storage (getItem throws) returns null', () => {
    const throwing: Storage = {
      getItem: () => {
        throw new Error('Storage disabled');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(loadOpenValidationPanel(PROJECT_A)).toBeNull();
  });

  it('9. save / clear swallow quota / privacy-mode errors and never throw', () => {
    const throwing: Storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
      removeItem: () => {
        throw new Error('Quota exceeded');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() =>
      saveOpenValidationPanel(PROJECT_A, '$.machines[0]'),
    ).not.toThrow();
    expect(() => saveOpenValidationPanel(PROJECT_A, null)).not.toThrow();
    expect(() => clearOpenValidationPanel(PROJECT_A)).not.toThrow();
  });
});

// =============================================================================
// Sprint 34 — validation report persistence (per project)
// =============================================================================

function reportKey(projectId: string): string {
  return `${VALIDATION_REPORT_STORAGE_KEY_PREFIX}${projectId}`;
}

const SAMPLE_REPORT: ValidationReport = {
  ok: false,
  issues: [
    {
      rule: 'R-ID-05',
      severity: 'error',
      message: 'Duplicate id',
      path: '$.machines[0].stations[0].id',
    },
  ],
};

describe('validation report storage (project-scoped)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. saves and loads a report round-trip with projectId + savedAt', () => {
    saveValidationReport(PROJECT_A, SAMPLE_REPORT);
    const loaded = loadValidationReport(PROJECT_A);
    expect(loaded).not.toBeNull();
    expect(loaded!.projectId).toBe(PROJECT_A);
    expect(typeof loaded!.savedAt).toBe('string');
    expect(loaded!.report).toEqual(SAMPLE_REPORT);
  });

  it('2. saving null clears the entry', () => {
    saveValidationReport(PROJECT_A, SAMPLE_REPORT);
    saveValidationReport(PROJECT_A, null);
    expect(loadValidationReport(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('3. missing entry returns null without writing', () => {
    expect(loadValidationReport(PROJECT_A)).toBeNull();
  });

  it('4. invalid JSON clears the entry + returns null', () => {
    localStorage.setItem(reportKey(PROJECT_A), 'not-valid-json{');
    expect(loadValidationReport(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('5. wrong shape (missing report.ok) clears + returns null', () => {
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt: '2024-01-01T00:00:00Z',
        report: { issues: [] }, // no `ok`
      }),
    );
    expect(loadValidationReport(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('5b. wrong shape (issues not array) clears + returns null', () => {
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt: '2024-01-01T00:00:00Z',
        report: { ok: true, issues: 'not-an-array' },
      }),
    );
    expect(loadValidationReport(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('6. payload `projectId` mismatch clears + returns null', () => {
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: 'someone-else',
        savedAt: '2024-01-01T00:00:00Z',
        report: SAMPLE_REPORT,
      }),
    );
    expect(loadValidationReport(PROJECT_A)).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('7. cross-project isolation — A and B are independent', () => {
    saveValidationReport(PROJECT_A, SAMPLE_REPORT);
    expect(loadValidationReport(PROJECT_B)).toBeNull();
    saveValidationReport(PROJECT_B, { ok: true, issues: [] });
    const a = loadValidationReport(PROJECT_A);
    const b = loadValidationReport(PROJECT_B);
    expect(a!.report).toEqual(SAMPLE_REPORT);
    expect(b!.report).toEqual({ ok: true, issues: [] });
  });

  it('8. throwing getItem returns null without crashing', () => {
    const throwing: Storage = {
      getItem: () => {
        throw new Error('Storage disabled');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(loadValidationReport(PROJECT_A)).toBeNull();
  });

  it('9. throwing setItem / removeItem swallowed by save / clear', () => {
    const throwing: Storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
      removeItem: () => {
        throw new Error('Quota exceeded');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => saveValidationReport(PROJECT_A, SAMPLE_REPORT)).not.toThrow();
    expect(() => saveValidationReport(PROJECT_A, null)).not.toThrow();
    expect(() => clearValidationReport(PROJECT_A)).not.toThrow();
  });
});

// =============================================================================
// Sprint 35 — validation report cache freshness (24h default + dependency-
// injected nowMs / maxAgeMs for deterministic tests)
// =============================================================================

describe('validation report storage — freshness window (sprint 35)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. exported default window is 24 hours', () => {
    expect(VALIDATION_REPORT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('2. fresh entry (1h old, default 24h window) loads', () => {
    const savedAt = new Date('2026-04-26T09:00:00.000Z').toISOString();
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt,
        report: SAMPLE_REPORT,
      }),
    );
    const nowMs = Date.parse('2026-04-26T10:00:00.000Z');
    const loaded = loadValidationReport(PROJECT_A, { nowMs });
    expect(loaded).not.toBeNull();
    expect(loaded!.report).toEqual(SAMPLE_REPORT);
  });

  it('3. stale entry (>24h, default window) is dropped + cleared', () => {
    const savedAt = new Date('2026-04-24T09:00:00.000Z').toISOString();
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt,
        report: SAMPLE_REPORT,
      }),
    );
    const nowMs = Date.parse('2026-04-26T10:00:00.000Z');
    expect(loadValidationReport(PROJECT_A, { nowMs })).toBeNull();
    // Stale entry is wiped on read so the next call returns "missing".
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('4. caller-supplied tighter window evicts otherwise-fresh entries', () => {
    const savedAt = new Date('2026-04-26T09:00:00.000Z').toISOString();
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt,
        report: SAMPLE_REPORT,
      }),
    );
    const nowMs = Date.parse('2026-04-26T10:00:00.000Z');
    // 30-minute window — saved 60 minutes ago, so stale.
    expect(
      loadValidationReport(PROJECT_A, { nowMs, maxAgeMs: 30 * 60 * 1000 }),
    ).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('5. unparseable savedAt clears + returns null', () => {
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt: 'not-a-real-date',
        report: SAMPLE_REPORT,
      }),
    );
    const nowMs = Date.parse('2026-04-26T10:00:00.000Z');
    expect(loadValidationReport(PROJECT_A, { nowMs })).toBeNull();
    expect(localStorage.getItem(reportKey(PROJECT_A))).toBeNull();
  });

  it('6. future savedAt is tolerated (clock skew, not stale)', () => {
    const savedAt = new Date('2026-04-26T11:00:00.000Z').toISOString();
    localStorage.setItem(
      reportKey(PROJECT_A),
      JSON.stringify({
        projectId: PROJECT_A,
        savedAt,
        report: SAMPLE_REPORT,
      }),
    );
    const nowMs = Date.parse('2026-04-26T10:00:00.000Z');
    const loaded = loadValidationReport(PROJECT_A, { nowMs });
    expect(loaded).not.toBeNull();
    expect(loaded!.report).toEqual(SAMPLE_REPORT);
  });
});

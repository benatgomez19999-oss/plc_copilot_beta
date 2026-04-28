// Sprint 78B — pure tests for the export helpers. No DOM access; the
// `triggerJsonDownload` / `triggerBundleDownload` wrappers are NOT
// covered here since they are thin DOM shims around `downloadText` /
// JSZip's `generateAsync` — both already exercised in `download.spec`.

import { describe, expect, it } from 'vitest';
import type { PirBuildResult, SourceRef } from '@plccopilot/electrical-ingest';

import {
  buildReviewBundleZip,
  computeExportAvailability,
  makeArtifactFileName,
  sanitizeBaseName,
  serializeBuildDiagnostics,
  serializeIngestionDiagnostics,
  serializePirJson,
  serializeReviewSession,
  serializeSourceMap,
} from '../src/utils/electrical-review-export.js';
import {
  createReviewSessionSnapshot,
  type ElectricalReviewSessionSnapshot,
} from '../src/utils/electrical-review-session.js';
import { SAMPLE_REVIEW_CANDIDATE } from '../src/utils/review-fixtures.js';
import { createInitialReviewState } from '../src/utils/review-state.js';

const NOW = '2026-04-28T12:00:00.000Z';

function snapshotFor(opts: {
  fileName?: string;
  inputKind?: 'csv' | 'xml' | 'unknown';
  sourceKind?: string;
  withBuild?: boolean;
}): ElectricalReviewSessionSnapshot {
  const build = opts.withBuild
    ? {
        attemptedAt: NOW,
        diagnostics: [],
        pir: { id: 'p1' },
        sourceMap: { 'io_b1': [{ sourceId: 'src-1', kind: 'csv' as const }] },
      }
    : undefined;
  return createReviewSessionSnapshot({
    source: {
      sourceId: 'src-1',
      fileName: opts.fileName,
      inputKind: opts.inputKind ?? 'csv',
      sourceKind: opts.sourceKind,
    },
    candidate: SAMPLE_REVIEW_CANDIDATE,
    reviewState: createInitialReviewState(SAMPLE_REVIEW_CANDIDATE),
    ingestionDiagnostics: [],
    build,
    nowIso: NOW,
  });
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

describe('sanitizeBaseName', () => {
  it('1. keeps safe chars intact', () => {
    expect(sanitizeBaseName('terminals_v1.2', 'X')).toBe('terminals_v1.2');
  });

  it('2. replaces unsafe chars with -', () => {
    expect(sanitizeBaseName('foo bar/baz?', 'X')).toBe('foo-bar-baz');
  });

  it('3. collapses runs of -', () => {
    expect(sanitizeBaseName('a   b   c', 'X')).toBe('a-b-c');
  });

  it('4. trims leading/trailing - and .', () => {
    expect(sanitizeBaseName('--foo..', 'X')).toBe('foo');
  });

  it('5. caps at 64 chars', () => {
    const long = 'a'.repeat(120);
    expect(sanitizeBaseName(long, 'X').length).toBeLessThanOrEqual(64);
  });

  it('6. falls back on empty / all-junk input', () => {
    expect(sanitizeBaseName('', 'fallback')).toBe('fallback');
    expect(sanitizeBaseName('   ', 'fallback')).toBe('fallback');
    expect(sanitizeBaseName('???', 'fallback')).toBe('fallback');
  });

  it('7. cannot produce path traversal segments', () => {
    expect(sanitizeBaseName('../../etc/passwd', 'X')).not.toContain('..');
    expect(sanitizeBaseName('..\\bad', 'X')).not.toContain('..');
  });
});

describe('makeArtifactFileName', () => {
  it('1. composes plccopilot-{base}-{suffix}', () => {
    expect(makeArtifactFileName('terminals.csv', 'review-session.json')).toBe(
      'plccopilot-terminals.csv-review-session.json',
    );
  });

  it('2. drops base when missing', () => {
    expect(makeArtifactFileName(undefined, 'pir-preview.json')).toBe(
      'plccopilot-pir-preview.json',
    );
    expect(makeArtifactFileName('', 'pir-preview.json')).toBe(
      'plccopilot-pir-preview.json',
    );
    expect(makeArtifactFileName(null, 'pir-preview.json')).toBe(
      'plccopilot-pir-preview.json',
    );
  });

  it('3. is deterministic for identical inputs', () => {
    expect(makeArtifactFileName('plan.xml', 'source-map.json')).toBe(
      makeArtifactFileName('plan.xml', 'source-map.json'),
    );
  });

  it('4. throws when suffix missing', () => {
    expect(() => makeArtifactFileName('x', '')).toThrow(/suffix/);
  });

  it('5. sanitises base', () => {
    expect(
      makeArtifactFileName('a b/c?', 'review-session.json'),
    ).toBe('plccopilot-a-b-c-review-session.json');
  });
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('serialisation helpers', () => {
  it('1. serializeReviewSession outputs pretty JSON with trailing newline', () => {
    const snap = snapshotFor({ fileName: 'terminals.csv' });
    const out = serializeReviewSession(snap);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.includes('  "schemaVersion": "electrical-review-session.v1"')).toBe(
      true,
    );
  });

  it('2. serializePirJson pretty-prints', () => {
    const out = serializePirJson({ id: 'p1' });
    expect(out).toBe('{\n  "id": "p1"\n}\n');
  });

  it('3. serializeSourceMap pretty-prints', () => {
    const map: Record<string, SourceRef[]> = {
      io_b1: [{ sourceId: 'x', kind: 'csv', line: 2 }],
    };
    const out = serializeSourceMap(map);
    expect(out).toContain('"io_b1"');
    expect(out).toContain('"line": 2');
  });

  it('4. serializeBuildDiagnostics pretty-prints', () => {
    const out = serializeBuildDiagnostics([
      {
        code: 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED',
        severity: 'info',
        message: 'placeholder',
      },
    ]);
    expect(out).toContain('PIR_BUILD_PLACEHOLDER_SEQUENCE_USED');
  });

  it('5. serializeIngestionDiagnostics pretty-prints', () => {
    const out = serializeIngestionDiagnostics([
      { code: 'TCECAD_XML_DETECTED', severity: 'info', message: 'detected' },
    ]);
    expect(out).toContain('TCECAD_XML_DETECTED');
  });
});

// ---------------------------------------------------------------------------
// Availability projection
// ---------------------------------------------------------------------------

describe('computeExportAvailability', () => {
  it('1. nothing available without a snapshot', () => {
    const a = computeExportAvailability({ snapshot: null });
    expect(a).toEqual({
      reviewSession: false,
      ingestionDiagnostics: false,
      pirJson: false,
      sourceMap: false,
      buildDiagnostics: false,
      bundle: false,
    });
  });

  it('2. snapshot only — review-session/ingestion/bundle enabled', () => {
    const a = computeExportAvailability({ snapshot: snapshotFor({}) });
    expect(a.reviewSession).toBe(true);
    expect(a.ingestionDiagnostics).toBe(true);
    expect(a.bundle).toBe(true);
    expect(a.pirJson).toBe(false);
    expect(a.sourceMap).toBe(false);
    expect(a.buildDiagnostics).toBe(false);
  });

  it('3. snapshot + buildResult with pir → pirJson + sourceMap + buildDiag enabled', () => {
    const buildResult: PirBuildResult = {
      pir: { id: 'p1' } as never,
      diagnostics: [],
      sourceMap: { io_b1: [{ sourceId: 'x', kind: 'csv' }] },
      acceptedInputCounts: { io: 1, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const a = computeExportAvailability({
      snapshot: snapshotFor({}),
      buildResult,
    });
    expect(a.pirJson).toBe(true);
    expect(a.sourceMap).toBe(true);
    expect(a.buildDiagnostics).toBe(true);
  });

  it('4. snapshot + refused build (no pir, no map) → only diagnostics enabled', () => {
    const buildResult: PirBuildResult = {
      diagnostics: [
        {
          code: 'PIR_BUILD_EMPTY_ACCEPTED_INPUT',
          severity: 'error',
          message: 'empty',
        },
      ],
      sourceMap: {},
      acceptedInputCounts: { io: 0, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const a = computeExportAvailability({
      snapshot: snapshotFor({}),
      buildResult,
    });
    expect(a.pirJson).toBe(false);
    expect(a.sourceMap).toBe(false);
    expect(a.buildDiagnostics).toBe(true);
  });

  it('5. saved build (no live result) still enables build artefacts', () => {
    const a = computeExportAvailability({
      snapshot: snapshotFor({ withBuild: true }),
    });
    expect(a.pirJson).toBe(true);
    expect(a.sourceMap).toBe(true);
    expect(a.buildDiagnostics).toBe(true);
  });

  it('6. empty sourceMap (live) is treated as unavailable', () => {
    const buildResult: PirBuildResult = {
      pir: { id: 'p1' } as never,
      diagnostics: [],
      sourceMap: {},
      acceptedInputCounts: { io: 1, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const a = computeExportAvailability({
      snapshot: snapshotFor({}),
      buildResult,
    });
    expect(a.sourceMap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bundle ZIP construction
// ---------------------------------------------------------------------------

describe('buildReviewBundleZip', () => {
  it('1. always includes review-session + ingestion-diagnostics + summary', () => {
    const zip = buildReviewBundleZip({ snapshot: snapshotFor({}) }, NOW);
    const names = Object.keys(zip.files).sort();
    expect(names).toContain('review-session.json');
    expect(names).toContain('ingestion-diagnostics.json');
    expect(names).toContain('summary.json');
  });

  it('2. excludes pir-preview / source-map / build-diagnostics when no build', () => {
    const zip = buildReviewBundleZip({ snapshot: snapshotFor({}) }, NOW);
    const names = Object.keys(zip.files).sort();
    expect(names).not.toContain('pir-preview.json');
    expect(names).not.toContain('source-map.json');
    expect(names).not.toContain('build-diagnostics.json');
  });

  it('3. includes build artefacts when live buildResult has them', async () => {
    const buildResult: PirBuildResult = {
      pir: { id: 'p1' } as never,
      diagnostics: [
        {
          code: 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED',
          severity: 'info',
          message: 'placeholder',
        },
      ],
      sourceMap: { io_b1: [{ sourceId: 'x', kind: 'csv' }] },
      acceptedInputCounts: { io: 1, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const zip = buildReviewBundleZip(
      { snapshot: snapshotFor({}), buildResult },
      NOW,
    );
    const names = Object.keys(zip.files).sort();
    expect(names).toContain('pir-preview.json');
    expect(names).toContain('source-map.json');
    expect(names).toContain('build-diagnostics.json');

    const pirText = await zip.file('pir-preview.json')!.async('string');
    expect(pirText).toContain('"id": "p1"');
  });

  it('4. summary.json carries the contents index + flags', async () => {
    const buildResult: PirBuildResult = {
      pir: { id: 'p1' } as never,
      diagnostics: [],
      sourceMap: { io_b1: [{ sourceId: 'x', kind: 'csv' }] },
      acceptedInputCounts: { io: 1, equipment: 0, assumptions: 0 },
      skippedInputCounts: { pending: 0, rejected: 0, unsupportedAssumptions: 0 },
    };
    const zip = buildReviewBundleZip(
      { snapshot: snapshotFor({ fileName: 'terminals.csv' }), buildResult },
      NOW,
    );
    const summary = JSON.parse(
      await zip.file('summary.json')!.async('string'),
    );
    expect(summary.schemaVersion).toBe('electrical-review-bundle.summary.v1');
    expect(summary.generatedAt).toBe(NOW);
    expect(summary.hasPir).toBe(true);
    expect(summary.hasSourceMap).toBe(true);
    expect(summary.buildAttempted).toBe(true);
    expect(summary.contents).toContain('review-session.json');
    expect(summary.contents).toContain('pir-preview.json');
    expect(summary.contents).toContain('source-map.json');
    expect(summary.contents).toContain('build-diagnostics.json');
    expect(summary.sourceFileName).toBe('terminals.csv');
    expect(summary.inputKind).toBe('csv');
  });

  it('5. throws when called without a snapshot or generatedAtIso', () => {
    expect(() =>
      buildReviewBundleZip({ snapshot: null as never }, NOW),
    ).toThrow(/snapshot/);
    expect(() =>
      buildReviewBundleZip({ snapshot: snapshotFor({}) }, ''),
    ).toThrow(/generatedAtIso/);
  });

  it('6. uses saved build artefacts when no live buildResult is supplied', () => {
    const zip = buildReviewBundleZip(
      { snapshot: snapshotFor({ withBuild: true }) },
      NOW,
    );
    const names = Object.keys(zip.files).sort();
    expect(names).toContain('pir-preview.json');
    expect(names).toContain('source-map.json');
    expect(names).toContain('build-diagnostics.json');
  });
});

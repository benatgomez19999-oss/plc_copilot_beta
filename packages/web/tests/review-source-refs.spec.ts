// Sprint 75 — pure tests for the source-ref drilldown helpers.

import { describe, expect, it } from 'vitest';

import {
  NO_SOURCE_REFS_SUMMARY,
  groupSourceRefsByKind,
  summarizeSourceRef,
} from '../src/utils/review-source-refs.js';
import type { SourceRef } from '@plccopilot/electrical-ingest';

const CSV_REF: SourceRef = {
  sourceId: 'src-1',
  kind: 'csv',
  path: 'list.csv',
  line: 5,
  rawId: 'B1',
  sheet: '=A1/12',
};

const EPLAN_REF: SourceRef = {
  sourceId: 'src-2',
  kind: 'eplan',
  path: 'plan.xml',
  line: 18,
  rawId: 'Y1',
  sheet: '=A1/13',
  symbol: '/EplanProject[1]/Pages[1]/Page[2]/Element[1]',
};

const MIN_REF: SourceRef = {
  sourceId: 'src-3',
  kind: 'manual',
};

describe('summarizeSourceRef — CSV', () => {
  const s = summarizeSourceRef(CSV_REF);

  it('produces stable fields in canonical order', () => {
    const labels = s.fields.map((f) => f.label);
    expect(labels).toEqual([
      'Source id',
      'Source kind',
      'File',
      'Line',
      'Sheet',
      'Raw id',
    ]);
  });

  it('one-liner contains kind, path, line, sheet and rawId', () => {
    expect(s.oneLiner).toContain('csv');
    expect(s.oneLiner).toContain('list.csv');
    expect(s.oneLiner).toContain('L5');
    expect(s.oneLiner).toContain('=A1/12');
    expect(s.oneLiner).toContain('B1');
  });

  it('exposes a stable key for React', () => {
    expect(s.key).toContain('csv');
    expect(s.key).toContain('list.csv');
    expect(s.key).toContain('5');
  });
});

describe('summarizeSourceRef — EPLAN', () => {
  const s = summarizeSourceRef(EPLAN_REF);

  it('labels the locator as "XML locator"', () => {
    const f = s.fields.find((x) => x.key === 'symbol');
    expect(f?.label).toBe('XML locator');
    expect(f?.value).toContain('/EplanProject[1]');
  });

  it('one-liner mentions kind=eplan', () => {
    expect(s.oneLiner).toContain('eplan');
  });
});

describe('summarizeSourceRef — minimal ref', () => {
  const s = summarizeSourceRef(MIN_REF);

  it('omits every absent optional field', () => {
    const labels = s.fields.map((f) => f.label).sort();
    expect(labels).toEqual(['Source id', 'Source kind']);
    expect(s.fields.find((f) => f.key === 'line')).toBeUndefined();
    expect(s.fields.find((f) => f.key === 'symbol')).toBeUndefined();
  });

  it('one-liner contains just the kind', () => {
    expect(s.oneLiner).toBe('manual');
  });
});

describe('groupSourceRefsByKind', () => {
  it('groups CSV + EPLAN refs in canonical order (eplan before csv)', () => {
    const groups = groupSourceRefsByKind([CSV_REF, EPLAN_REF]);
    expect(groups.map((g) => g.kind)).toEqual(['eplan', 'csv']);
    expect(groups[0].refs.length).toBe(1);
    expect(groups[1].refs.length).toBe(1);
  });

  it('drops null/non-object entries safely', () => {
    const groups = groupSourceRefsByKind([
      CSV_REF,
      null as unknown as SourceRef,
      undefined as unknown as SourceRef,
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].refs.length).toBe(1);
  });

  it('returns an empty array for empty input', () => {
    expect(groupSourceRefsByKind([])).toEqual([]);
  });

  it('keeps unknown kinds at the end of the list (deterministic)', () => {
    const odd = { ...MIN_REF, kind: 'unknown' as const };
    const groups = groupSourceRefsByKind([CSV_REF, odd]);
    expect(groups[groups.length - 1].kind).toBe('unknown');
  });
});

describe('NO_SOURCE_REFS_SUMMARY', () => {
  it('is a frozen sentinel for the "no evidence" branch', () => {
    expect(NO_SOURCE_REFS_SUMMARY.fields).toEqual([]);
    expect(NO_SOURCE_REFS_SUMMARY.oneLiner.toLowerCase()).toContain(
      'no source evidence',
    );
    expect(Object.isFrozen(NO_SOURCE_REFS_SUMMARY)).toBe(true);
  });
});

// =============================================================================
// Sprint 82 — PDF source-evidence projection (snippet + bbox)
// =============================================================================

describe('summarizeSourceRef — Sprint 82 PDF snippet + bbox projection', () => {
  it('1. surfaces snippet as a "Snippet" field when present', () => {
    const ref: SourceRef = {
      sourceId: 's1',
      kind: 'pdf',
      path: 'plan.pdf',
      page: '24',
      line: 6,
      symbol: 'pdf:page:24/line:6',
      snippet: 'I0.0 B1 Part present',
    };
    const summary = summarizeSourceRef(ref);
    const labels = summary.fields.map((f) => f.label);
    expect(labels).toContain('Snippet');
    const snippetField = summary.fields.find((f) => f.label === 'Snippet');
    expect(snippetField?.value).toBe('I0.0 B1 Part present');
  });

  it('2. surfaces bbox as a single "Bounding box" field with unit', () => {
    const ref: SourceRef = {
      sourceId: 's1',
      kind: 'pdf',
      path: 'plan.pdf',
      page: '24',
      bbox: { x: 50, y: 700.5, width: 120.25, height: 12, unit: 'pt' },
    };
    const summary = summarizeSourceRef(ref);
    const bboxField = summary.fields.find((f) => f.label === 'Bounding box');
    expect(bboxField).toBeDefined();
    expect(bboxField?.value).toContain('x=50.0');
    expect(bboxField?.value).toContain('y=700.5');
    expect(bboxField?.value).toContain('w=120.3');
    expect(bboxField?.value).toContain('h=12.0');
    expect(bboxField?.value).toContain('(pt)');
  });

  it('3. omits snippet/bbox cleanly when absent (no "undefined" leaks)', () => {
    const ref: SourceRef = { sourceId: 's1', kind: 'pdf', page: '24' };
    const summary = summarizeSourceRef(ref);
    const labels = summary.fields.map((f) => f.label);
    expect(labels).not.toContain('Snippet');
    expect(labels).not.toContain('Bounding box');
    for (const f of summary.fields) {
      expect(f.value.toLowerCase()).not.toContain('undefined');
    }
  });

  it('4. tolerates a malformed bbox (missing fields drop the projection)', () => {
    const ref = {
      sourceId: 's1',
      kind: 'pdf' as const,
      // bbox shape malformed: missing height + unit. The
      // projection must NOT render a half-baked field.
      bbox: { x: 1, y: 2, width: 3 } as never,
    } as SourceRef;
    const summary = summarizeSourceRef(ref);
    expect(summary.fields.find((f) => f.label === 'Bounding box')).toBeUndefined();
  });
});

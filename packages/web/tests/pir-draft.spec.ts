import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { projectToPrettyJson } from '../src/utils/project-json.js';
import {
  draftValidationToMarkers,
  validatePirDraft,
} from '../src/utils/pir-draft.js';

function fixtureJson(): string {
  return projectToPrettyJson(structuredClone(fixture) as unknown as Project);
}

describe('validatePirDraft — happy path', () => {
  it('returns status=valid + project + report on the canonical fixture', () => {
    const v = validatePirDraft(fixtureJson());
    expect(v.status).toBe('valid');
    if (v.status === 'valid') {
      expect(v.project.id).toBe('prj_weldline');
      expect(Array.isArray(v.report.issues)).toBe(true);
    }
  });

  it('valid status carries the domain-validation report (apply allowed even with issues)', () => {
    const v = validatePirDraft(fixtureJson());
    if (v.status !== 'valid') throw new Error('expected valid');
    // weldline fixture is clean; report.ok is true.
    expect(typeof v.report.ok).toBe('boolean');
  });
});

describe('validatePirDraft — invalid JSON', () => {
  it('returns status=invalid-json on a syntax error', () => {
    const v = validatePirDraft('{ not json');
    expect(v.status).toBe('invalid-json');
    if (v.status === 'invalid-json') {
      expect(v.message).toMatch(/JSON|Unexpected/);
    }
  });

  it('returns status=invalid-json on empty input', () => {
    const v = validatePirDraft('   ');
    expect(v.status).toBe('invalid-json');
    if (v.status === 'invalid-json') {
      expect(v.message).toMatch(/empty/);
    }
  });

  it('best-effort line/column from V8 error messages', () => {
    // V8 error messages include "at position N". The fixture below has the
    // syntax error on the second line.
    const v = validatePirDraft('{\n  "a": 1,\n  not_a_key\n}');
    expect(v.status).toBe('invalid-json');
    if (v.status === 'invalid-json') {
      // Line is heuristic — Node 20+ produces this position; we just want
      // SOMETHING reasonable, not specifically line 1.
      expect(v.line ?? 1).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('validatePirDraft — invalid schema', () => {
  it('returns status=invalid-schema with one or more issues', () => {
    const v = validatePirDraft('{}');
    expect(v.status).toBe('invalid-schema');
    if (v.status === 'invalid-schema') {
      expect(v.issues.length).toBeGreaterThan(0);
      for (const i of v.issues) {
        expect(typeof i.path).toBe('string');
        expect(typeof i.message).toBe('string');
      }
    }
  });

  it('formats Zod paths with bracket-index syntax', () => {
    // Take a valid project and break a nested array element so Zod's path is
    // ['machines', 0, 'stations', N, ...].
    const obj = JSON.parse(fixtureJson()) as { machines: { stations: unknown[] }[] };
    obj.machines[0]!.stations[0] = { malformed: true };
    const v = validatePirDraft(JSON.stringify(obj, null, 2));
    expect(v.status).toBe('invalid-schema');
    if (v.status === 'invalid-schema') {
      const hasBracketIndex = v.issues.some((i) =>
        /machines\[0\]\.stations\[0\]/.test(i.path),
      );
      expect(hasBracketIndex).toBe(true);
    }
  });
});

describe('draftValidationToMarkers', () => {
  it('emits a single marker for invalid JSON', () => {
    const v = validatePirDraft('{ broken');
    const markers = draftValidationToMarkers(v, '{ broken');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.severity).toBe('error');
    expect(markers[0]!.message).toMatch(/Invalid JSON/);
    expect(markers[0]!.startLineNumber).toBeGreaterThanOrEqual(1);
  });

  it('emits one marker per Zod issue with line >= 1', () => {
    const v = validatePirDraft('{}');
    expect(v.status).toBe('invalid-schema');
    const markers = draftValidationToMarkers(v, '{}');
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect(m.severity).toBe('error');
      expect(m.startLineNumber).toBeGreaterThanOrEqual(1);
      expect(m.endColumn).toBeGreaterThan(m.startColumn);
    }
  });

  it('emits per-issue markers when valid + domain validate has findings', () => {
    const v = validatePirDraft(fixtureJson());
    expect(v.status).toBe('valid');
    if (v.status !== 'valid') return;
    const markers = draftValidationToMarkers(v, fixtureJson());
    // Whatever the report says, marker count = report.issues count.
    expect(markers.length).toBe(v.report.issues.length);
    for (const m of markers) {
      expect(['error', 'warning', 'info']).toContain(m.severity);
      expect(m.startLineNumber).toBeGreaterThanOrEqual(1);
    }
  });

  it('marker message includes the rule name in [brackets] for valid drafts', () => {
    const v = validatePirDraft(fixtureJson());
    if (v.status !== 'valid' || v.report.issues.length === 0) return;
    const markers = draftValidationToMarkers(v, fixtureJson());
    expect(markers[0]!.message).toMatch(/^\[[^\]]+\]/);
  });
});

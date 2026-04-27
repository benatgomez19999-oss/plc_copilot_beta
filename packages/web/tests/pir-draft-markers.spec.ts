import { describe, expect, it } from 'vitest';
import type { Project, ValidationReport } from '@plccopilot/pir';
import {
  draftValidationToMarkers,
  type EditorMarkerLike,
  type PirDraftValidation,
} from '../src/utils/pir-draft.js';

/**
 * Slice the substring an `EditorMarkerLike` covers, the same way the
 * sprint-26 range-locator tests verify their output. Lets every marker
 * assertion talk about the highlighted text rather than raw column
 * numbers — readable AND a lossless encoding of the four corners.
 *
 * `endColumn` is treated as exclusive (Monaco convention), matching
 * what `pir-draft.ts` produces.
 */
function slice(text: string, m: EditorMarkerLike): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let l = m.startLineNumber; l <= m.endLineNumber; l++) {
    const line = lines[l - 1] ?? '';
    const startCol = l === m.startLineNumber ? m.startColumn : 1;
    const endCol = l === m.endLineNumber ? m.endColumn : line.length + 1;
    out.push(line.slice(startCol - 1, endCol - 1));
  }
  return out.join('\n');
}

const SAMPLE = `{
  "pir_version": "0.1.0",
  "id": "prj",
  "name": "Demo",
  "machines": [
    {
      "id": "m",
      "name": "M1"
    }
  ]
}
`;

// =============================================================================
// 1. Invalid JSON
// =============================================================================

describe('draftValidationToMarkers — invalid JSON', () => {
  it('1. emits a single error marker at the parse location', () => {
    const v: PirDraftValidation = {
      status: 'invalid-json',
      message: 'Unexpected token',
      line: 3,
      column: 5,
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m).toBeDefined();
    expect(m!.severity).toBe('error');
    expect(m!.message).toMatch(/^Invalid JSON:/);
    expect(m!.startLineNumber).toBe(3);
    expect(m!.startColumn).toBe(5);
    expect(m!.endLineNumber).toBe(3);
    expect(m!.endColumn).toBe(6); // start + 1
  });

  it('1b. falls back to line 1 col 1 when parse location is absent', () => {
    const v: PirDraftValidation = {
      status: 'invalid-json',
      message: 'Some error',
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.startLineNumber).toBe(1);
    expect(m!.startColumn).toBe(1);
    expect(m!.endColumn).toBe(2);
  });
});

// =============================================================================
// 2-4. Schema issues — exact value ranges
// =============================================================================

describe('draftValidationToMarkers — schema issues', () => {
  it('2. root scalar field highlights exactly the quoted value', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.name', message: 'Expected string' }],
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.severity).toBe('error');
    expect(m!.message).toBe('PIR schema: Expected string');
    expect(slice(SAMPLE, m!)).toBe('"Demo"');
  });

  it('3. nested machine field highlights its exact value', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.machines[0].name', message: 'Expected string' }],
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(slice(SAMPLE, m!)).toBe('"M1"');
  });

  it('4. array element path highlights the element body', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.machines[0]', message: 'Strict object check failed' }],
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    const s = slice(SAMPLE, m!);
    expect(s.startsWith('{')).toBe(true);
    expect(s.endsWith('}')).toBe(true);
    expect(s).toContain('"id": "m"');
  });
});

// =============================================================================
// 5-6. Valid status — domain validation issues with exact ranges
// =============================================================================

function reportWith(issues: ValidationReport['issues']): ValidationReport {
  return { ok: issues.length === 0, issues };
}

function asValid(report: ValidationReport): PirDraftValidation {
  // The marker generator never reads `validation.project`, so we cast a
  // sentinel through `unknown` rather than spinning up a full PIR.
  return {
    status: 'valid',
    project: {} as unknown as Project,
    report,
  };
}

describe('draftValidationToMarkers — domain validation', () => {
  it('5. validation issue with JSONPath highlights the exact value', () => {
    const v = asValid(
      reportWith([
        {
          rule: 'R-ID-05',
          severity: 'warning',
          message: 'Duplicate id detected',
          path: '$.machines[0].id',
        },
      ]),
    );
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.severity).toBe('warning');
    expect(m!.message).toBe('[R-ID-05] Duplicate id detected');
    expect(slice(SAMPLE, m!)).toBe('"m"');
  });

  it('6. validation issue with object-path highlights balanced braces', () => {
    const v = asValid(
      reportWith([
        {
          rule: 'R-MACH-01',
          severity: 'error',
          message: 'machine fails',
          path: '$.machines[0]',
        },
      ]),
    );
    const [m] = draftValidationToMarkers(v, SAMPLE);
    const s = slice(SAMPLE, m!);
    expect(s.startsWith('{')).toBe(true);
    expect(s.endsWith('}')).toBe(true);
  });
});

// =============================================================================
// 7-8. Path failures fall back safely
// =============================================================================

describe('draftValidationToMarkers — fallback paths', () => {
  it('7. unresolvable path falls back to a full-line range without throwing', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.does_not_exist', message: 'X' }],
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.startLineNumber).toBe(1);
    // A line-fallback marker spans the whole line — endColumn > startColumn.
    expect(m!.endColumn).toBeGreaterThan(m!.startColumn);
  });

  it('8. empty Zod path falls back to line 1 with visible width', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '', message: 'Root issue' }],
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.startLineNumber).toBe(1);
    expect(m!.endLineNumber).toBe(1);
    expect(m!.endColumn).toBeGreaterThanOrEqual(2);
  });

  it('8b. validation issue without a path falls back to line 1', () => {
    const v = asValid(
      reportWith([
        { rule: 'X', severity: 'info', message: 'Generic note', path: '' },
      ]),
    );
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.startLineNumber).toBe(1);
    expect(m!.severity).toBe('info');
  });
});

// =============================================================================
// 9-11. Message formatting + severity preservation
// =============================================================================

describe('draftValidationToMarkers — message + severity formatting', () => {
  it('9. schema markers prefix the message with `PIR schema:`', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.name', message: 'Expected string, got number' }],
    };
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.message).toBe('PIR schema: Expected string, got number');
  });

  it('10. validation markers wrap the rule id in brackets', () => {
    const v = asValid(
      reportWith([
        {
          rule: 'R-IO-07',
          severity: 'error',
          message: 'IO id missing',
          path: '$.machines[0].id',
        },
      ]),
    );
    const [m] = draftValidationToMarkers(v, SAMPLE);
    expect(m!.message).toMatch(/^\[R-IO-07\]/);
  });

  it('11. severity preserved across error / warning / info', () => {
    const v = asValid(
      reportWith([
        { rule: 'A', severity: 'error', message: 'a', path: '$.name' },
        { rule: 'B', severity: 'warning', message: 'b', path: '$.id' },
        { rule: 'C', severity: 'info', message: 'c', path: '$.pir_version' },
      ]),
    );
    const markers = draftValidationToMarkers(v, SAMPLE);
    expect(markers.map((x) => x.severity)).toEqual([
      'error',
      'warning',
      'info',
    ]);
  });
});

// =============================================================================
// 12-14. Determinism, immutability, multi-issue ordering
// =============================================================================

describe('draftValidationToMarkers — determinism + ordering', () => {
  it('12. repeated calls with identical inputs produce identical output', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.machines[0].name', message: 'X' }],
    };
    expect(draftValidationToMarkers(v, SAMPLE)).toEqual(
      draftValidationToMarkers(v, SAMPLE),
    );
  });

  it('13. input text is not mutated', () => {
    const before = SAMPLE;
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [{ path: '$.name', message: 'X' }],
    };
    draftValidationToMarkers(v, SAMPLE);
    expect(SAMPLE).toBe(before);
  });

  it('14. multiple issues on the same path produce multiple markers in source order', () => {
    const v = asValid(
      reportWith([
        { rule: 'A', severity: 'error', message: 'first', path: '$.name' },
        {
          rule: 'B',
          severity: 'warning',
          message: 'second',
          path: '$.name',
        },
      ]),
    );
    const markers = draftValidationToMarkers(v, SAMPLE);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.message).toBe('[A] first');
    expect(markers[1]!.message).toBe('[B] second');
    expect(slice(SAMPLE, markers[0]!)).toBe('"Demo"');
    expect(slice(SAMPLE, markers[1]!)).toBe('"Demo"');
  });
});

// =============================================================================
// 15. Slice round-trip across mixed issues
// =============================================================================

describe('draftValidationToMarkers — slice round-trip', () => {
  it('15. each marker slice equals the JSON value it points at, across kinds', () => {
    const v = asValid(
      reportWith([
        { rule: 'X', severity: 'error', message: 'm1', path: '$.name' },
        { rule: 'Y', severity: 'warning', message: 'm2', path: '$.id' },
        {
          rule: 'Z',
          severity: 'info',
          message: 'm3',
          path: '$.machines[0].id',
        },
      ]),
    );
    const markers = draftValidationToMarkers(v, SAMPLE);
    expect(slice(SAMPLE, markers[0]!)).toBe('"Demo"');
    expect(slice(SAMPLE, markers[1]!)).toBe('"prj"');
    expect(slice(SAMPLE, markers[2]!)).toBe('"m"');
  });
});

// =============================================================================
// 16. Bonus — ranges keep `endColumn > startColumn` invariant on same line
// =============================================================================

describe('draftValidationToMarkers — invariants', () => {
  it('16. every emitted marker has visible width (endColumn > startColumn on same line)', () => {
    const v: PirDraftValidation = {
      status: 'invalid-schema',
      issues: [
        { path: '$.name', message: 'a' },
        { path: '$.machines[0].id', message: 'b' },
        { path: '$.does_not_exist', message: 'c' }, // fallback path
        { path: '', message: 'd' }, // empty path → line 1
      ],
    };
    for (const m of draftValidationToMarkers(v, SAMPLE)) {
      if (m.startLineNumber === m.endLineNumber) {
        expect(m.endColumn).toBeGreaterThan(m.startColumn);
      }
    }
  });
});

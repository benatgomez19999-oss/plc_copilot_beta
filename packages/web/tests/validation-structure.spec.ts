import { describe, expect, it } from 'vitest';
import type { Issue } from '@plccopilot/pir';
import {
  countValidationIssueListItems,
  filterValidationIssueListItems,
  firstValidationIssueDescendantPath,
  formatValidationSeverityBreakdown,
  hasValidationIssueFilterResults,
  sortValidationIssueListItems,
  validationIssueBreakdownsFromReport,
  validationIssueCountsFromReport,
  validationIssueDescendantPaths,
  validationIssueDescendants,
  validationIssuePathsFromReport,
  validationIssuesForNode,
  type ValidationIssueListItem,
} from '../src/utils/validation-structure.js';

/**
 * Hand-build issues with the right shape — keeps the spec free of
 * fixture wiring. The PIR `Issue` shape is { rule, severity, message,
 * path }; helpers ignore everything except severity + path.
 */
function issue(
  path: string,
  severity: 'error' | 'warning' | 'info' = 'error',
  rule = 'R-X',
  message = 'm',
): Issue {
  return { rule, severity, message, path };
}

// =============================================================================
// 1. Empty report
// =============================================================================

describe('validation-structure — empty input', () => {
  it('1. empty issues yields empty maps for both helpers', () => {
    expect(validationIssueCountsFromReport([])).toEqual(new Map());
    expect(validationIssueBreakdownsFromReport([])).toEqual(new Map());
  });
});

// =============================================================================
// 2-8. Per-level lifting
// =============================================================================

describe('validation-structure — per-level lifting', () => {
  it('2. issue with empty path folds to the project root `$`', () => {
    const counts = validationIssueCountsFromReport([issue('')]);
    expect(counts.get('$')).toBe(1);
    expect(counts.size).toBe(1);
  });

  it('2b. issue with explicit `$` path also folds to root', () => {
    const counts = validationIssueCountsFromReport([issue('$')]);
    expect(counts.get('$')).toBe(1);
    expect(counts.size).toBe(1);
  });

  it('3. machine-level issue lifts to root + machine only', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].name'),
    ]);
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBeUndefined();
  });

  it('4. machine.io issue lifts to root + machine, never station / equipment', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].io[0].name'),
    ]);
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBeUndefined();
    expect(
      counts.get('$.machines[0].stations[0].equipment[0]'),
    ).toBeUndefined();
  });

  it('5. station-level issue lifts to root + machine + station', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].stations[1].name'),
    ]);
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[1]')).toBe(1);
    expect(
      counts.get('$.machines[0].stations[1].equipment[0]'),
    ).toBeUndefined();
  });

  it('6. equipment-level issue lifts through all four ancestors', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].stations[0].equipment[2].code_symbol'),
    ]);
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0].equipment[2]')).toBe(1);
  });

  it('7. issue under equipment.io_bindings still rolls up through equipment', () => {
    const counts = validationIssueCountsFromReport([
      issue(
        '$.machines[0].stations[0].equipment[1].io_bindings.solenoid_out',
      ),
    ]);
    expect(counts.get('$.machines[0].stations[0].equipment[1]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$')).toBe(1);
  });

  it('8. issue under station.sequence rolls up to station, NOT equipment', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].stations[0].sequence.transitions[0].timeout'),
    ]);
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBe(1);
    expect(
      counts.get('$.machines[0].stations[0].equipment[0]'),
    ).toBeUndefined();
  });
});

// =============================================================================
// 9-11. Substring trap + multi-issue + sibling isolation
// =============================================================================

describe('validation-structure — multi-issue counting', () => {
  it('9. no substring trap: stations[1] does not catch stations[10]', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].stations[10].name'),
    ]);
    expect(counts.get('$.machines[0].stations[10]')).toBe(1);
    expect(counts.get('$.machines[0].stations[1]')).toBeUndefined();
  });

  it('10. multiple issues under one equipment sum at every ancestor', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].stations[0].equipment[0].name'),
      issue('$.machines[0].stations[0].equipment[0].code_symbol'),
      issue('$.machines[0].stations[0].equipment[0].io_bindings'),
    ]);
    expect(counts.get('$')).toBe(3);
    expect(counts.get('$.machines[0]')).toBe(3);
    expect(counts.get('$.machines[0].stations[0]')).toBe(3);
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBe(3);
  });

  it('11. siblings count separately and sum at the shared ancestor', () => {
    const counts = validationIssueCountsFromReport([
      issue('$.machines[0].stations[0].equipment[0].name'),
      issue('$.machines[0].stations[0].equipment[1].name'),
    ]);
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0].equipment[1]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBe(2);
    expect(counts.get('$.machines[0]')).toBe(2);
    expect(counts.get('$')).toBe(2);
  });
});

// =============================================================================
// 12. Severity breakdown
// =============================================================================

describe('validation-structure — severity breakdown', () => {
  it('12. errors, warnings and info are counted into separate buckets', () => {
    const issues: Issue[] = [
      issue('$.machines[0].name', 'error'),
      issue('$.machines[0].id', 'error'),
      issue('$.machines[0].stations[0].name', 'warning'),
      issue('$.machines[0].stations[0].equipment[0].name', 'info'),
    ];
    const breakdowns = validationIssueBreakdownsFromReport(issues);
    expect(breakdowns.get('$')).toEqual({
      errors: 2,
      warnings: 1,
      info: 1,
    });
    expect(breakdowns.get('$.machines[0]')).toEqual({
      errors: 2,
      warnings: 1,
      info: 1,
    });
    expect(breakdowns.get('$.machines[0].stations[0]')).toEqual({
      errors: 0,
      warnings: 1,
      info: 1,
    });
    expect(
      breakdowns.get('$.machines[0].stations[0].equipment[0]'),
    ).toEqual({ errors: 0, warnings: 0, info: 1 });
  });
});

// =============================================================================
// 13-14. formatValidationSeverityBreakdown
// =============================================================================

describe('formatValidationSeverityBreakdown', () => {
  it('13. empty breakdown returns the no-issues sentinel', () => {
    expect(
      formatValidationSeverityBreakdown({ errors: 0, warnings: 0, info: 0 }),
    ).toBe('No validation issues');
  });

  it('14a. pluralizes errors and warnings, treats info as mass noun', () => {
    expect(
      formatValidationSeverityBreakdown({ errors: 1, warnings: 0, info: 0 }),
    ).toBe('1 error');
    expect(
      formatValidationSeverityBreakdown({ errors: 2, warnings: 0, info: 0 }),
    ).toBe('2 errors');
    expect(
      formatValidationSeverityBreakdown({ errors: 0, warnings: 1, info: 0 }),
    ).toBe('1 warning');
    expect(
      formatValidationSeverityBreakdown({ errors: 0, warnings: 2, info: 0 }),
    ).toBe('2 warnings');
    expect(
      formatValidationSeverityBreakdown({ errors: 0, warnings: 0, info: 3 }),
    ).toBe('3 info');
  });

  it('14b. canonical order errors → warnings → info, zero buckets omitted', () => {
    expect(
      formatValidationSeverityBreakdown({ errors: 2, warnings: 1, info: 0 }),
    ).toBe('2 errors · 1 warning');
    expect(
      formatValidationSeverityBreakdown({ errors: 0, warnings: 1, info: 3 }),
    ).toBe('1 warning · 3 info');
    expect(
      formatValidationSeverityBreakdown({ errors: 1, warnings: 1, info: 1 }),
    ).toBe('1 error · 1 warning · 1 info');
  });
});

// =============================================================================
// 15-17. Descendant path lookups
// =============================================================================

const SAMPLE_ISSUES: Issue[] = [
  issue('$.machines[0].name', 'error', 'A', 'machine name issue'),
  issue(
    '$.machines[0].stations[1].equipment[0].name',
    'warning',
    'B',
    'eq name issue',
  ),
  issue(
    '$.machines[0].stations[1].equipment[0].code_symbol',
    'error',
    'C',
    'symbol issue',
  ),
  issue('$.machines[0].stations[0].name', 'info', 'D', 'station note'),
];

describe('validation-structure — descendant queries', () => {
  it('15. root returns every issue path in the original report order', () => {
    expect(validationIssueDescendantPaths('$', SAMPLE_ISSUES)).toEqual([
      '$.machines[0].name',
      '$.machines[0].stations[1].equipment[0].name',
      '$.machines[0].stations[1].equipment[0].code_symbol',
      '$.machines[0].stations[0].name',
    ]);
  });

  it('15b. validationIssuePathsFromReport mirrors the per-issue path normalization', () => {
    expect(validationIssuePathsFromReport(SAMPLE_ISSUES)).toEqual(
      SAMPLE_ISSUES.map((i) => i.path),
    );
  });

  it('16. station path filters to its own subtree only', () => {
    expect(
      validationIssueDescendantPaths(
        '$.machines[0].stations[1]',
        SAMPLE_ISSUES,
      ),
    ).toEqual([
      '$.machines[0].stations[1].equipment[0].name',
      '$.machines[0].stations[1].equipment[0].code_symbol',
    ]);
    expect(
      validationIssueDescendantPaths(
        '$.machines[0].stations[0]',
        SAMPLE_ISSUES,
      ),
    ).toEqual(['$.machines[0].stations[0].name']);
  });

  it('17. firstValidationIssueDescendantPath returns the first descendant or null', () => {
    expect(
      firstValidationIssueDescendantPath(
        '$.machines[0].stations[1]',
        SAMPLE_ISSUES,
      ),
    ).toBe('$.machines[0].stations[1].equipment[0].name');
    expect(
      firstValidationIssueDescendantPath(
        '$.machines[0].stations[2]',
        SAMPLE_ISSUES,
      ),
    ).toBeNull();
  });
});

// =============================================================================
// 18. Cycle-friendly duplicate preservation
// =============================================================================

describe('validation-structure — duplicate preservation', () => {
  it('18. duplicate paths are preserved so repeated badge clicks still cycle through each issue', () => {
    // Two distinct rules firing at the same JSONPath. The cycle
    // consumer (App's badgeCycleRef) modulo-indexes into this array,
    // so two entries means two clicks before wrap-around — the user
    // can mentally tick off each issue even though Monaco scrolls to
    // the same line both times.
    const issues: Issue[] = [
      issue('$.machines[0].id', 'error', 'R-ID-01', 'shape'),
      issue('$.machines[0].id', 'error', 'R-ID-05', 'duplicate'),
    ];
    const paths = validationIssueDescendantPaths('$.machines[0]', issues);
    expect(paths).toEqual([
      '$.machines[0].id',
      '$.machines[0].id',
    ]);
    // Counts and breakdowns reflect the two issues (no dedup).
    const counts = validationIssueCountsFromReport(issues);
    expect(counts.get('$.machines[0]')).toBe(2);
    const breakdowns = validationIssueBreakdownsFromReport(issues);
    expect(breakdowns.get('$.machines[0]')).toEqual({
      errors: 2,
      warnings: 0,
      info: 0,
    });
  });
});

// =============================================================================
// validationIssueDescendants (sprint 29 — severity-aware cycle target)
// =============================================================================

describe('validationIssueDescendants', () => {
  it('1. root returns every issue with severity preserved, in original order', () => {
    const issues: Issue[] = [
      issue('$.machines[0].name', 'error'),
      issue('$.machines[0].id', 'warning'),
      issue('$.machines[0].stations[0].id', 'info'),
    ];
    expect(validationIssueDescendants('$', issues)).toEqual([
      { path: '$.machines[0].name', severity: 'error' },
      { path: '$.machines[0].id', severity: 'warning' },
      { path: '$.machines[0].stations[0].id', severity: 'info' },
    ]);
  });

  it('2. station path filters to its own subtree only', () => {
    const issues: Issue[] = [
      issue('$.machines[0].name', 'error'),
      issue('$.machines[0].stations[0].id', 'info'),
      issue('$.machines[0].stations[1].id', 'warning'),
    ];
    expect(
      validationIssueDescendants(
        '$.machines[0].stations[0]',
        issues,
      ),
    ).toEqual([{ path: '$.machines[0].stations[0].id', severity: 'info' }]);
  });

  it('3. duplicates with different severity are preserved as distinct cycle stops', () => {
    const issues: Issue[] = [
      issue('$.machines[0].id', 'error', 'R-ID-01'),
      issue('$.machines[0].id', 'warning', 'R-ID-05'),
    ];
    expect(
      validationIssueDescendants('$.machines[0]', issues),
    ).toEqual([
      { path: '$.machines[0].id', severity: 'error' },
      { path: '$.machines[0].id', severity: 'warning' },
    ]);
  });

  it('4. issue with empty path becomes a "$" target so root jumps work', () => {
    const issues: Issue[] = [issue('', 'error', 'R-PROJ', 'project')];
    expect(validationIssueDescendants('$', issues)).toEqual([
      { path: '$', severity: 'error' },
    ]);
  });

  it('5. validationIssueDescendantPaths delegates and preserves path order', () => {
    const issues: Issue[] = [
      issue('$.a', 'error'),
      issue('$.b', 'warning'),
      issue('$.c', 'info'),
    ];
    const paths = validationIssueDescendantPaths('$', issues);
    const targets = validationIssueDescendants('$', issues);
    expect(paths).toEqual(targets.map((t) => t.path));
  });

  it('5b. delegation also preserves duplicates between the two helpers', () => {
    const issues: Issue[] = [
      issue('$.machines[0].id', 'error'),
      issue('$.machines[0].id', 'warning'),
    ];
    expect(
      validationIssueDescendantPaths('$.machines[0]', issues),
    ).toEqual(
      validationIssueDescendants('$.machines[0]', issues).map((t) => t.path),
    );
  });
});

// =============================================================================
// validationIssuesForNode (sprint 30 — list-panel item shape)
// =============================================================================

describe('validationIssuesForNode', () => {
  it('1. root returns every issue with all metadata + index in original order', () => {
    const issues: Issue[] = [
      issue('$.machines[0].name', 'error', 'R-A', 'first'),
      issue('$.machines[0].id', 'warning', 'R-B', 'second'),
      issue('$.machines[0].stations[0].id', 'info', 'R-C', 'third'),
    ];
    expect(validationIssuesForNode('$', issues)).toEqual<
      ValidationIssueListItem[]
    >([
      {
        path: '$.machines[0].name',
        severity: 'error',
        rule: 'R-A',
        message: 'first',
        index: 0,
      },
      {
        path: '$.machines[0].id',
        severity: 'warning',
        rule: 'R-B',
        message: 'second',
        index: 1,
      },
      {
        path: '$.machines[0].stations[0].id',
        severity: 'info',
        rule: 'R-C',
        message: 'third',
        index: 2,
      },
    ]);
  });

  it('2. station path filters to its own subtree', () => {
    const issues: Issue[] = [
      issue('$.machines[0].name', 'error', 'R-A'),
      issue('$.machines[0].stations[0].id', 'info', 'R-B'),
      issue('$.machines[0].stations[1].id', 'warning', 'R-C'),
    ];
    const items = validationIssuesForNode(
      '$.machines[0].stations[0]',
      issues,
    );
    expect(items.map((i) => i.path)).toEqual([
      '$.machines[0].stations[0].id',
    ]);
    expect(items[0]!.index).toBe(1);
  });

  it('3. equipment path filters to that equipment subtree only', () => {
    const issues: Issue[] = [
      issue('$.machines[0].stations[0].equipment[0].name', 'error'),
      issue('$.machines[0].stations[0].equipment[1].name', 'warning'),
      issue('$.machines[0].stations[0].name', 'info'),
    ];
    const items = validationIssuesForNode(
      '$.machines[0].stations[0].equipment[0]',
      issues,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('error');
    expect(items[0]!.index).toBe(0);
  });

  it('4. duplicates at the same path get distinct indices, not deduped', () => {
    const issues: Issue[] = [
      issue('$.machines[0].id', 'error', 'R-ID-01', 'shape'),
      issue('$.machines[0].id', 'error', 'R-ID-05', 'duplicate'),
    ];
    const items = validationIssuesForNode('$.machines[0]', issues);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.index)).toEqual([0, 1]);
    expect(items.map((i) => i.rule)).toEqual(['R-ID-01', 'R-ID-05']);
  });

  it('5. issue with empty path becomes a `$` target so root jumps work', () => {
    const issues: Issue[] = [
      issue('', 'error', 'R-PROJ', 'project-level'),
    ];
    expect(validationIssuesForNode('$', issues)).toEqual<
      ValidationIssueListItem[]
    >([
      {
        path: '$',
        severity: 'error',
        rule: 'R-PROJ',
        message: 'project-level',
        index: 0,
      },
    ]);
  });

  it('6. no substring trap — stations[1] does not catch stations[10]', () => {
    const issues: Issue[] = [
      issue('$.machines[0].stations[10].name', 'error', 'R-A'),
      issue('$.machines[0].stations[1].name', 'warning', 'R-B'),
    ];
    const items = validationIssuesForNode(
      '$.machines[0].stations[1]',
      issues,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('warning');
    expect(items[0]!.index).toBe(1);
  });

  it('7. no match returns []', () => {
    const issues: Issue[] = [issue('$.machines[0].name', 'error')];
    expect(
      validationIssuesForNode('$.machines[0].stations[5]', issues),
    ).toEqual([]);
    expect(validationIssuesForNode('', issues)).toEqual([]);
    expect(validationIssuesForNode('$', [])).toEqual([]);
  });
});

// =============================================================================
// sortValidationIssueListItems (sprint 30 — display order for the list)
// =============================================================================

function item(
  path: string,
  severity: Issue['severity'],
  rule: string,
  index: number,
  message = '',
): ValidationIssueListItem {
  return { path, severity, rule, message, index };
}

describe('sortValidationIssueListItems', () => {
  it('8. does NOT mutate the input', () => {
    const items: ValidationIssueListItem[] = [
      item('$.b', 'info', 'X', 0),
      item('$.a', 'error', 'Y', 1),
    ];
    const before = JSON.stringify(items);
    const sorted = sortValidationIssueListItems(items);
    expect(JSON.stringify(items)).toBe(before);
    expect(sorted).not.toBe(items); // fresh array
  });

  it('9. severity rank: error < warning < info, regardless of input order', () => {
    const items: ValidationIssueListItem[] = [
      item('$.a', 'info', 'X', 0),
      item('$.a', 'error', 'X', 1),
      item('$.a', 'warning', 'X', 2),
    ];
    expect(
      sortValidationIssueListItems(items).map((i) => i.severity),
    ).toEqual(['error', 'warning', 'info']);
  });

  it('10. within the same severity, paths sort lexicographically', () => {
    const items: ValidationIssueListItem[] = [
      item('$.b', 'error', 'X', 0),
      item('$.a', 'error', 'X', 1),
      item('$.c', 'error', 'X', 2),
    ];
    expect(sortValidationIssueListItems(items).map((i) => i.path)).toEqual([
      '$.a',
      '$.b',
      '$.c',
    ]);
  });

  it('11. within severity + path, rules sort lexicographically', () => {
    const items: ValidationIssueListItem[] = [
      item('$.a', 'error', 'R-Z', 0),
      item('$.a', 'error', 'R-A', 1),
      item('$.a', 'error', 'R-M', 2),
    ];
    expect(sortValidationIssueListItems(items).map((i) => i.rule)).toEqual([
      'R-A',
      'R-M',
      'R-Z',
    ]);
  });

  it('12. on full-key matches, original `index` is the final tie-breaker (stable)', () => {
    // Two entries identical on severity / path / rule — only index
    // distinguishes them. Sort must keep the lower-index one first.
    const items: ValidationIssueListItem[] = [
      item('$.a', 'error', 'R-X', 5, 'second'),
      item('$.a', 'error', 'R-X', 2, 'first'),
    ];
    const sorted = sortValidationIssueListItems(items);
    expect(sorted.map((i) => i.index)).toEqual([2, 5]);
    expect(sorted.map((i) => i.message)).toEqual(['first', 'second']);
  });
});

// =============================================================================
// countValidationIssueListItems (sprint 31)
// =============================================================================

describe('countValidationIssueListItems', () => {
  it('1. empty list yields all-zero counts', () => {
    expect(countValidationIssueListItems([])).toEqual({
      total: 0,
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });

  it('2. mixed severities are bucketed correctly + total matches length', () => {
    const items: ValidationIssueListItem[] = [
      item('$.a', 'error', 'R1', 0),
      item('$.a', 'error', 'R2', 1),
      item('$.b', 'warning', 'R3', 2),
      item('$.c', 'info', 'R4', 3),
      item('$.c', 'info', 'R5', 4),
    ];
    expect(countValidationIssueListItems(items)).toEqual({
      total: 5,
      errors: 2,
      warnings: 1,
      info: 2,
    });
  });

  it('3. duplicate issues at the same path each count individually (no dedup)', () => {
    const items: ValidationIssueListItem[] = [
      item('$.a', 'error', 'R-X', 0),
      item('$.a', 'error', 'R-Y', 1),
    ];
    expect(countValidationIssueListItems(items)).toEqual({
      total: 2,
      errors: 2,
      warnings: 0,
      info: 0,
    });
  });
});

// =============================================================================
// filterValidationIssueListItems (sprint 31)
// =============================================================================

describe('filterValidationIssueListItems', () => {
  const sample: ValidationIssueListItem[] = [
    item('$.a', 'error', 'R1', 0),
    item('$.b', 'warning', 'R2', 1),
    item('$.c', 'info', 'R3', 2),
    item('$.d', 'error', 'R4', 3),
  ];

  it('4. "all" returns a fresh copy preserving original order', () => {
    const result = filterValidationIssueListItems(sample, 'all');
    expect(result).not.toBe(sample);
    expect(result).toEqual(sample);
  });

  it('5. "error" returns only the error rows', () => {
    expect(filterValidationIssueListItems(sample, 'error')).toEqual([
      sample[0],
      sample[3],
    ]);
  });

  it('6. "warning" returns only the warning rows', () => {
    expect(filterValidationIssueListItems(sample, 'warning')).toEqual([
      sample[1],
    ]);
  });

  it('7. "info" returns only the info rows', () => {
    expect(filterValidationIssueListItems(sample, 'info')).toEqual([
      sample[2],
    ]);
  });

  it('8. input array is not mutated', () => {
    const before = JSON.stringify(sample);
    filterValidationIssueListItems(sample, 'error');
    expect(JSON.stringify(sample)).toBe(before);
  });
});

// =============================================================================
// hasValidationIssueFilterResults (sprint 31)
// =============================================================================

describe('hasValidationIssueFilterResults', () => {
  const sample: ValidationIssueListItem[] = [
    item('$.a', 'error', 'R1', 0),
    item('$.b', 'warning', 'R2', 1),
  ];

  it('9. true when the filter has matching items', () => {
    expect(hasValidationIssueFilterResults(sample, 'error')).toBe(true);
    expect(hasValidationIssueFilterResults(sample, 'warning')).toBe(true);
  });

  it('10. false when the filter has no matches in this list', () => {
    expect(hasValidationIssueFilterResults(sample, 'info')).toBe(false);
  });

  it('11. "all" is true for any non-empty list', () => {
    expect(hasValidationIssueFilterResults(sample, 'all')).toBe(true);
    expect(
      hasValidationIssueFilterResults(
        [item('$.a', 'info', 'R1', 0)],
        'all',
      ),
    ).toBe(true);
  });

  it('12. "all" is false when the list is empty', () => {
    expect(hasValidationIssueFilterResults([], 'all')).toBe(false);
    expect(hasValidationIssueFilterResults([], 'error')).toBe(false);
  });
});

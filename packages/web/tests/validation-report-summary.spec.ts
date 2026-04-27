import { describe, expect, it } from 'vitest';
import type { Issue, ValidationReport } from '@plccopilot/pir';
import {
  countValidationReportIssues,
  formatValidationReportCounts,
  restoredValidationReportMessage,
  validationReportTone,
} from '../src/utils/validation-report-summary.js';
import type { SavedValidationReport } from '../src/utils/storage.js';

function issue(severity: Issue['severity'], rule = 'r', path = '$'): Issue {
  return { severity, rule, message: 'msg', path };
}

function report(...issues: Issue[]): ValidationReport {
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

function saved(
  r: ValidationReport,
  savedAt: string,
): SavedValidationReport {
  return { projectId: 'p1', savedAt, report: r };
}

describe('countValidationReportIssues', () => {
  it('1. empty report → all-zero counts', () => {
    expect(countValidationReportIssues(report())).toEqual({
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });

  it('2. mixed severities → bucketed counts', () => {
    const r = report(
      issue('error'),
      issue('error'),
      issue('warning'),
      issue('info'),
      issue('info'),
      issue('info'),
    );
    expect(countValidationReportIssues(r)).toEqual({
      errors: 2,
      warnings: 1,
      info: 3,
    });
  });

  it('3. unknown severity defaults to errors (never silently dropped)', () => {
    const odd = { severity: 'critical', rule: 'r', message: 'm', path: '$' };
    const r: ValidationReport = {
      ok: false,
      issues: [odd as unknown as Issue],
    };
    expect(countValidationReportIssues(r)).toEqual({
      errors: 1,
      warnings: 0,
      info: 0,
    });
  });
});

describe('formatValidationReportCounts', () => {
  it('4. all-zero → "passed"', () => {
    expect(
      formatValidationReportCounts({ errors: 0, warnings: 0, info: 0 }),
    ).toBe('passed');
  });

  it('5. plural shape with zero buckets kept inline', () => {
    expect(
      formatValidationReportCounts({ errors: 2, warnings: 1, info: 0 }),
    ).toBe('2 errors, 1 warning, 0 info');
  });

  it('6. singular vs plural for errors / warnings; info stays mass noun', () => {
    expect(
      formatValidationReportCounts({ errors: 1, warnings: 1, info: 1 }),
    ).toBe('1 error, 1 warning, 1 info');
    expect(
      formatValidationReportCounts({ errors: 0, warnings: 5, info: 7 }),
    ).toBe('0 errors, 5 warnings, 7 info');
  });
});

describe('validationReportTone', () => {
  it('7. any errors → "error"', () => {
    expect(
      validationReportTone({ errors: 1, warnings: 0, info: 0 }),
    ).toBe('error');
    expect(
      validationReportTone({ errors: 1, warnings: 5, info: 9 }),
    ).toBe('error');
  });

  it('8. no errors but warnings → "warning"', () => {
    expect(
      validationReportTone({ errors: 0, warnings: 1, info: 0 }),
    ).toBe('warning');
    expect(
      validationReportTone({ errors: 0, warnings: 4, info: 2 }),
    ).toBe('warning');
  });

  it('9. info-only or all-zero → "info"', () => {
    expect(validationReportTone({ errors: 0, warnings: 0, info: 0 })).toBe(
      'info',
    );
    expect(validationReportTone({ errors: 0, warnings: 0, info: 3 })).toBe(
      'info',
    );
  });
});

describe('restoredValidationReportMessage', () => {
  const now = Date.parse('2026-04-26T10:00:00.000Z');

  it('10. composes age + counts (5 min, mixed report)', () => {
    const s = saved(
      report(issue('error'), issue('error'), issue('warning')),
      new Date(now - 5 * 60_000).toISOString(),
    );
    expect(restoredValidationReportMessage(s, now)).toBe(
      'Restored validation report from local browser storage (5 min ago). Last result: 2 errors, 1 warning, 0 info.',
    );
  });

  it('11. unparseable savedAt → "unknown time ago" but counts still render', () => {
    const s: SavedValidationReport = {
      projectId: 'p1',
      savedAt: 'not-a-date',
      report: report(issue('info')),
    };
    expect(restoredValidationReportMessage(s, now)).toBe(
      'Restored validation report from local browser storage (unknown time ago). Last result: 0 errors, 0 warnings, 1 info.',
    );
  });

  it('12. empty report renders as "passed"', () => {
    const s = saved(report(), new Date(now).toISOString());
    expect(restoredValidationReportMessage(s, now)).toBe(
      'Restored validation report from local browser storage (just now). Last result: passed.',
    );
  });
});

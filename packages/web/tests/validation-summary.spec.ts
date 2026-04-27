import { describe, expect, it } from 'vitest';
import type { Issue } from '@plccopilot/pir';
import {
  groupIssuesByPath,
  summarizeValidationIssues,
} from '../src/utils/validation-summary.js';

const SAMPLE: readonly Issue[] = [
  { rule: 'R1', severity: 'error', path: 'machines[0].stations[1]', message: 'a' },
  { rule: 'R2', severity: 'warning', path: 'machines[0].stations[1]', message: 'b' },
  { rule: 'R3', severity: 'info', path: 'machines[0].alarms[0]', message: 'c' },
  { rule: 'R4', severity: 'error', path: 'machines[0].alarms[0]', message: 'd' },
  { rule: 'R5', severity: 'info', path: '', message: 'e' },
];

describe('summarizeValidationIssues', () => {
  it('counts severities correctly', () => {
    expect(summarizeValidationIssues(SAMPLE)).toEqual({
      errors: 2,
      warnings: 1,
      info: 2,
    });
  });

  it('returns zero counts for an empty list', () => {
    expect(summarizeValidationIssues([])).toEqual({
      errors: 0,
      warnings: 0,
      info: 0,
    });
  });

  it('does not mutate the input array', () => {
    const original = [...SAMPLE];
    summarizeValidationIssues(SAMPLE);
    expect(SAMPLE).toEqual(original);
  });
});

describe('groupIssuesByPath', () => {
  it('groups issues by path and sorts paths alphabetically', () => {
    const groups = groupIssuesByPath(SAMPLE);
    expect(groups.map((g) => g.path)).toEqual([
      '(no path)',
      'machines[0].alarms[0]',
      'machines[0].stations[1]',
    ]);
  });

  it('within each group, errors come before warnings before info', () => {
    const groups = groupIssuesByPath(SAMPLE);
    const alarms = groups.find((g) => g.path === 'machines[0].alarms[0]');
    expect(alarms?.issues.map((i) => i.severity)).toEqual(['error', 'info']);
  });

  it('preserves issue identity (no copies of issue contents)', () => {
    const groups = groupIssuesByPath(SAMPLE);
    const all = groups.flatMap((g) => g.issues);
    expect(all.length).toBe(SAMPLE.length);
    for (const i of SAMPLE) {
      expect(all).toContain(i);
    }
  });

  it('handles an empty list', () => {
    expect(groupIssuesByPath([])).toEqual([]);
  });
});

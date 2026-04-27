import type { Issue } from '@plccopilot/pir';

export interface IssueCounts {
  errors: number;
  warnings: number;
  info: number;
}

/**
 * Tally an issue list by severity. Used by `PirViewer` for the inline
 * summary line ("3 errors, 1 warning, 0 info"). Pure, no I/O — easy to
 * unit-test.
 *
 * Unrecognised severities (defensive: shouldn't happen given the typed
 * `Severity` union) are silently dropped from the counts.
 */
export function summarizeValidationIssues(
  issues: readonly Issue[],
): IssueCounts {
  const out: IssueCounts = { errors: 0, warnings: 0, info: 0 };
  for (const i of issues) {
    if (i.severity === 'error') out.errors++;
    else if (i.severity === 'warning') out.warnings++;
    else if (i.severity === 'info') out.info++;
  }
  return out;
}

/**
 * Group issues by their `path` so the UI can render a compact table without
 * repeating identical paths. Within each group, severity rank is preserved
 * (errors first → warnings → info) so the most important entry leads.
 */
export function groupIssuesByPath(
  issues: readonly Issue[],
): Array<{ path: string; issues: Issue[] }> {
  const map = new Map<string, Issue[]>();
  for (const i of issues) {
    const key = i.path || '(no path)';
    const arr = map.get(key);
    if (arr) arr.push(i);
    else map.set(key, [i]);
  }
  const rank: Record<Issue['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return Array.from(map.entries())
    .map(([path, list]) => ({
      path,
      issues: list.slice().sort((a, b) => rank[a.severity] - rank[b.severity]),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

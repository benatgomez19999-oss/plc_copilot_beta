export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  rule: string;
  severity: Severity;
  path: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: Issue[];
}

export function emptyReport(): ValidationReport {
  return { ok: true, issues: [] };
}

export function addIssue(report: ValidationReport, issue: Issue): void {
  report.issues.push(issue);
  if (issue.severity === 'error') report.ok = false;
}

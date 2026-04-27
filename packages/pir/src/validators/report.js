export function emptyReport() {
    return { ok: true, issues: [] };
}
export function addIssue(report, issue) {
    report.issues.push(issue);
    if (issue.severity === 'error')
        report.ok = false;
}

import type { Project, ValidationReport } from '@plccopilot/pir';
import { projectToPrettyJson } from './project-json.js';
import { validatePirDraft } from './pir-draft.js';

/**
 * Discriminated union describing the relationship between the in-flight
 * draft JSON and the currently applied project.
 *
 *  - `valid`            — draft parses, matches the PIR schema, AND differs
 *                         from the applied JSON. The structure navigator can
 *                         optionally show this project instead of the
 *                         applied one.
 *  - `same-as-applied`  — draft parses cleanly but its canonical text is
 *                         byte-identical to the applied project's. There is
 *                         nothing distinct to view.
 *  - `invalid`          — draft fails JSON parse (`reason: 'json'`) or PIR
 *                         schema validation (`reason: 'schema'`). The
 *                         message is one short, user-displayable string;
 *                         full marker rendering still happens in PirEditor.
 *
 * NOTE: `valid` may carry a `report` with `errors > 0` — domain
 * `validate()` failures do not block apply (and therefore do not block the
 * draft view either). Schema failures are the only thing that rules a
 * draft out of view.
 */
export type DraftProjectState =
  | { kind: 'valid'; project: Project; report: ValidationReport }
  | { kind: 'same-as-applied'; project: Project; report: ValidationReport }
  | { kind: 'invalid'; reason: 'json' | 'schema'; message: string };

/**
 * Pure helper used by App's `useMemo([draftJson, appliedProject])`.
 *
 * Reuses the existing `validatePirDraft` (so JSON / Zod / domain validate
 * logic is not duplicated) and decides between `valid` and
 * `same-as-applied` by comparing the draft string to the applied project's
 * canonical pretty-print. The comparison must be stable across runs — that
 * is exactly the contract `projectToPrettyJson` already provides.
 */
export function getDraftProjectState(
  draftJson: string,
  appliedProject: Project | null,
): DraftProjectState {
  const draft = validatePirDraft(draftJson);

  if (draft.status === 'invalid-json') {
    return { kind: 'invalid', reason: 'json', message: draft.message };
  }
  if (draft.status === 'invalid-schema') {
    const first = draft.issues[0];
    const message = first
      ? `${first.path || '(root)'}: ${first.message}`
      : 'PIR schema mismatch.';
    return { kind: 'invalid', reason: 'schema', message };
  }

  // status === 'valid' from here on.
  if (appliedProject) {
    const appliedJson = projectToPrettyJson(appliedProject);
    if (appliedJson === draftJson) {
      return {
        kind: 'same-as-applied',
        project: draft.project,
        report: draft.report,
      };
    }
  }

  return {
    kind: 'valid',
    project: draft.project,
    report: draft.report,
  };
}

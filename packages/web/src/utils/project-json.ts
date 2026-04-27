import type { Project } from '@plccopilot/pir';

/**
 * Pretty-print a PIR project as JSON for read-only display.
 *
 *   - 2-space indent (matches what most fixtures + IDEs use)
 *   - trailing newline (POSIX-friendly when copied to a file)
 *   - deterministic across calls — `JSON.stringify` preserves the
 *     property insertion order V8 uses, which is stable for any given
 *     `Project` instance built from `ProjectSchema.parse`
 *
 * No sorting / no reformatting beyond pretty-printing. The viewer is a
 * faithful echo of the PIR the user loaded.
 */
export function projectToPrettyJson(project: Project): string {
  return JSON.stringify(project, null, 2) + '\n';
}

import { readFileSync } from 'node:fs';
import { ProjectSchema, type Project } from '@plccopilot/pir';
import { fail } from '../errors.js';

/**
 * Load a PIR JSON file, parse it, and validate against `ProjectSchema`.
 *
 * Failures are converted to `CliError` with exit code 1:
 *   - file does not exist / unreadable
 *   - JSON parse error
 *   - PIR schema mismatch (Zod issues)
 *
 * Returns a strongly-typed `Project` on success.
 */
export function readProjectFromFile(path: string): Project {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    fail(`cannot read PIR file "${path}"`, 1, e);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON in "${path}"`, 1, e);
  }

  const result = ProjectSchema.safeParse(json);
  if (!result.success) {
    const issueLines = result.error.issues
      .slice(0, 10)
      .map((i) => `    • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    const tail =
      result.error.issues.length > 10
        ? `\n    … (+${result.error.issues.length - 10} more)`
        : '';
    fail(
      `PIR schema validation failed for "${path}":\n${issueLines}${tail}`,
      1,
    );
  }

  return result.data;
}

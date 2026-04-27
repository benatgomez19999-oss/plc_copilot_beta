import {
  ProjectSchema,
  validate,
  type Issue,
  type Project,
  type ValidationReport,
} from '@plccopilot/pir';
import { findJsonPathLine } from './json-locator.js';
import {
  findJsonPathValueRange,
  type JsonTextRange,
} from './json-range-locator.js';

// =============================================================================
// Discriminated union — every state of an in-progress edit.
// `valid` carries the parsed Project AND the domain-validation report.
// `validate(project)` may surface errors/warnings; the apply gate only checks
// SCHEMA validity, so a `valid` draft can still have report.errors > 0.
// =============================================================================

export interface SchemaIssueLike {
  path: string;
  message: string;
}

export type PirDraftValidation =
  | {
      status: 'valid';
      project: Project;
      report: ValidationReport;
    }
  | {
      status: 'invalid-json';
      message: string;
      line?: number;
      column?: number;
    }
  | {
      status: 'invalid-schema';
      issues: SchemaIssueLike[];
    };

/**
 * Run the three-stage validation pipeline:
 *   1. JSON.parse (catches malformed text)
 *   2. ProjectSchema.safeParse (catches PIR shape mismatch)
 *   3. validate(project) (domain rules — errors don't block apply)
 *
 * Pure: no DOM, no Monaco. The PIR editor calls this on every debounced
 * keystroke; tests call it with hand-crafted strings.
 */
export function validatePirDraft(jsonText: string): PirDraftValidation {
  if (jsonText.trim() === '') {
    return { status: 'invalid-json', message: 'PIR JSON is empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const loc = parseJsonErrorLocation(message, jsonText);
    return loc
      ? { status: 'invalid-json', message, line: loc.line, column: loc.column }
      : { status: 'invalid-json', message };
  }

  const safe = ProjectSchema.safeParse(parsed);
  if (!safe.success) {
    return {
      status: 'invalid-schema',
      issues: safe.error.issues.map((i) => ({
        path: joinZodPath(i.path as ReadonlyArray<string | number>),
        message: i.message,
      })),
    };
  }

  const report = validate(safe.data);
  return { status: 'valid', project: safe.data, report };
}

// =============================================================================
// Marker generation — pure, no Monaco. The consumer maps `severity` to
// monaco.MarkerSeverity at render time.
// =============================================================================

export interface EditorMarkerLike {
  severity: 'error' | 'warning' | 'info';
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Convert a draft-validation result into Monaco-friendly markers.
 *
 * Sprint 27 upgrade: every Zod / domain-validation issue with a JSONPath
 * is now resolved to a precise value range via `findJsonPathValueRange`
 * (sprint 26), so the squiggle underlines exactly the JSON value that
 * caused the issue — not the entire line. The locator is best-effort:
 * when it can't resolve the path (malformed JSON, stale path, root), we
 * fall back to a full-line range, and finally to line 1 — the marker is
 * always renderable. JSON syntax errors keep their parse-location
 * point markers.
 *
 * Output order mirrors the validation report: tests rely on it for
 * stable assertions, and Monaco renders markers in the order it
 * receives them.
 */
export function draftValidationToMarkers(
  validation: PirDraftValidation,
  jsonText: string,
): EditorMarkerLike[] {
  switch (validation.status) {
    case 'invalid-json': {
      const line = validation.line ?? 1;
      const column = validation.column ?? 1;
      return [
        {
          severity: 'error',
          message: `Invalid JSON: ${validation.message}`,
          startLineNumber: line,
          startColumn: column,
          endLineNumber: line,
          endColumn: column + 1,
        },
      ];
    }
    case 'invalid-schema': {
      return validation.issues.map(
        (i): EditorMarkerLike => ({
          severity: 'error',
          // The marker range now points at the offending path, so the
          // path prefix the previous version baked into the message is
          // redundant. `PIR schema:` keeps the marker discoverable in
          // Monaco's problem list.
          message: `PIR schema: ${i.message}`,
          ...jsonPathRangeOrLine(jsonText, i.path),
        }),
      );
    }
    case 'valid': {
      return validation.report.issues.map(
        (issue: Issue): EditorMarkerLike => ({
          severity: issue.severity,
          message: `[${issue.rule}] ${issue.message}`,
          ...jsonPathRangeOrLine(jsonText, issue.path),
        }),
      );
    }
  }
}

// =============================================================================
// Range helpers — private, pure, total-function. Tests exercise them
// indirectly through `draftValidationToMarkers`.
// =============================================================================

/**
 * Resolve a JSONPath to either an exact value range (preferred) or a
 * line range (fallback). Always returns a usable range so callers can
 * spread it straight into a marker without null-checking.
 *
 * The cascade is:
 *   1. `findJsonPathValueRange` — exact start/end of the JSON value
 *      (string body with quotes, number tokens, balanced braces).
 *   2. `findJsonPathLine` — line where the key lives. Whole line is
 *      underlined.
 *   3. Line 1 — terminal fallback. Used when the path is empty / null
 *      / unresolvable; nothing is more wrong than crashing the marker
 *      pipeline.
 */
function jsonPathRangeOrLine(
  jsonText: string,
  jsonPath: string | null | undefined,
): JsonTextRange {
  if (typeof jsonPath === 'string' && jsonPath.trim() !== '') {
    const exact = findJsonPathValueRange(jsonText, jsonPath);
    if (exact) return exact;
    const line = findJsonPathLine(jsonText, jsonPath);
    if (line !== null && line >= 1) return lineRange(jsonText, line);
  }
  return lineRange(jsonText, 1);
}

/**
 * Whole-line range as a `JsonTextRange`. Clamps `lineNumber` into the
 * actual line count of `jsonText` so a stale path against a shrunk
 * document still produces a valid marker (Monaco silently truncates
 * out-of-range corners, but we'd rather not rely on that).
 *
 * `endColumn` is exclusive (Monaco convention). For empty lines we
 * still emit `endColumn = 2` so the marker has visible width — Monaco
 * does not render zero-width squiggles.
 */
function lineRange(jsonText: string, lineNumber: number): JsonTextRange {
  const lines = jsonText.split('\n');
  const lineCount = lines.length || 1;
  const safeLine =
    Number.isFinite(lineNumber) && lineNumber >= 1
      ? Math.min(Math.floor(lineNumber), lineCount)
      : 1;
  const lineText = lines[safeLine - 1] ?? '';
  const endCol = Math.max(2, lineText.length + 1);
  return {
    startLineNumber: safeLine,
    startColumn: 1,
    endLineNumber: safeLine,
    endColumn: endCol,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Convert a Zod path (`['machines', 0, 'stations', 1, 'id']`) into the
 * string form `parseJsonPath` understands (`machines[0].stations[1].id`).
 */
function joinZodPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      out += out === '' ? seg : `.${seg}`;
    }
  }
  return out;
}

/**
 * Best-effort line/column extraction from V8 / Node JSON.parse errors.
 * Modern errors include `at position N`; we convert to (line, column).
 * Older / non-V8 engines may return undefined location and the marker
 * lands on line 1.
 */
function parseJsonErrorLocation(
  message: string,
  text: string,
): { line: number; column: number } | null {
  const m = /position (\d+)/.exec(message);
  if (!m) return null;
  const pos = Number(m[1]);
  if (!Number.isInteger(pos) || pos < 0) return null;
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

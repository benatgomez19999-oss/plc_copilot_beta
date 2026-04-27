/**
 * Pure helpers for the compile-error banner.
 *
 * The banner lives in `App.tsx` and consumes
 * `formatSerializedCompilerError` output. We split a single useful
 * predicate out so it can be unit-tested without rendering React.
 */

/**
 * `true` when the formatted compiler-error message has a leading
 * `[CODE]` token that the banner should be able to highlight as a
 * separate visual chip. The match is intentionally tight — only the
 * exact `[UPPER_SNAKE]` shape that `formatSerializedCompilerError`
 * emits qualifies. Anything else (plain `Error: ...`, freeform user
 * notes) returns `false` so the banner falls back to a plain text
 * presentation.
 */
export function hasErrorCodePrefix(message: string): boolean {
  return /^\[[A-Z][A-Z0-9_]*\]\s/.test(message);
}

/**
 * Split a formatted error into `{ code?: string; rest: string }`. When
 * the message has no `[CODE]` prefix the whole string is returned in
 * `rest` and `code` is `undefined`. Used by the banner to render the
 * code as a separate inline pill.
 */
export function splitErrorCodePrefix(message: string): {
  code?: string;
  rest: string;
} {
  const m = /^\[([A-Z][A-Z0-9_]*)\]\s+([\s\S]*)$/.exec(message);
  if (!m) return { rest: message };
  return { code: m[1], rest: m[2]! };
}

/**
 * Sprint 43 — gate predicate for the compile-error banner's
 * "Jump to PIR" affordance. Only paths the PIR editor can actually
 * find should light the button up:
 *
 *   - `'$'`               → root, treated as "go to top of file"
 *   - `'machines[…]…'`    → bracket-indexed PIR JSON path produced
 *                           by `diagnostic-paths.ts` helpers
 *
 * Rejects:
 *   - `''` / `null` / `undefined`
 *   - logical FB-name placeholders like `'FB_StLoad'` (the editor
 *     can't resolve them — clicking would silently no-op)
 *   - anything else (defensive)
 */
export function isPirJsonPath(
  path: string | null | undefined,
): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path === '$') return true;
  return /^machines\[\d+\]/.test(path);
}

/**
 * Pure helpers for the PIR editor focus-pulse path.
 *
 * Kept tiny on purpose — these are the only pieces of the
 * `focusRequest → reveal + decorate` flow that don't depend on a live
 * Monaco editor instance, so they can be unit-tested without a DOM.
 */

/**
 * Tone of the transient focus highlight.
 *
 *   - `'neutral'` (sprint 25 / 26 default) — change-badge clicks,
 *     FieldDiff jumps, the node-level "Find in PIR editor" button.
 *     Blue line tint + yellow value box.
 *   - `'error' | 'warning' | 'info'` (sprint 29) — validation-badge
 *     clicks. The tone matches `Issue.severity` so the colour of the
 *     transient highlight communicates *why* we jumped here.
 */
export type FocusHighlightTone = 'neutral' | 'error' | 'warning' | 'info';

/**
 * Alias used by the App-level `focusRequest` shape. Same set of values
 * as `FocusHighlightTone`; named differently because at the App layer
 * the tone is conceptually a "severity" inherited from
 * `Issue.severity`, while at the CSS layer it's a "tone".
 */
export type PirFocusSeverity = FocusHighlightTone;

/**
 * Clamp `lineNumber` into `[1, lineCount]`. Used right before
 * `revealLineInCenter` / `setPosition` / `new monaco.Range(...)` so
 * Monaco never sees `NaN`, `0`, a negative, or an out-of-range value.
 *
 * Defensive defaults:
 *   - null / undefined / NaN / non-finite  → 1
 *   - lineNumber < 1                       → 1
 *   - lineNumber > lineCount               → lineCount
 *   - lineCount < 1                        → 1 (degenerate model — single
 *                                              empty line is still line 1)
 *
 * The function is total: it always returns a positive integer ≥ 1.
 */
/**
 * Map a focus-tone enum to the CSS class suffix the editor appends to
 * each base highlight class (`pir-focus-line-highlight`, etc.).
 *
 * Convention: a non-empty suffix begins with `-` so callers can splice
 * directly: `` `pir-focus-line-highlight${suffix}` ``. `'neutral'`,
 * `null`, `undefined`, and any defensive cast all return `''` so the
 * editor reuses the base (neutral) styling.
 *
 * Total-function: never throws, always returns a string.
 */
export function focusToneClassSuffix(
  tone: FocusHighlightTone | null | undefined,
): string {
  if (tone === 'error') return '-error';
  if (tone === 'warning') return '-warning';
  if (tone === 'info') return '-info';
  return '';
}

export function clampEditorLine(
  lineNumber: number | null | undefined,
  lineCount: number,
): number {
  const safeLineCount =
    Number.isFinite(lineCount) && lineCount >= 1 ? Math.floor(lineCount) : 1;
  if (
    lineNumber === null ||
    lineNumber === undefined ||
    !Number.isFinite(lineNumber)
  ) {
    return 1;
  }
  const intLine = Math.floor(lineNumber);
  if (intLine < 1) return 1;
  if (intLine > safeLineCount) return safeLineCount;
  return intLine;
}

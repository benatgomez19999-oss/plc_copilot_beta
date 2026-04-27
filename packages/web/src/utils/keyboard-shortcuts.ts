/**
 * Pure keyboard-chord predicates for App-level shortcuts. Each
 * helper accepts the minimal `Pick<KeyboardEvent, …>` shape it
 * needs so unit tests can pass plain object literals — no
 * `KeyboardEvent` constructor required.
 */

/**
 * Sprint 35 — `Ctrl+Shift+V` (Linux / Windows) or `Cmd+Shift+V`
 * (macOS) triggers Validate. Modifier rules:
 *
 *   - `altKey`     must be `false` (Alt is reserved for the
 *                  filter shortcuts and Alt+L panel toggle)
 *   - `shiftKey`   must be `true`
 *   - exactly one of `ctrlKey | metaKey` must be `true`
 *   - `key.toLowerCase() === 'v'` — case-insensitive because
 *     some keyboard layouts emit `'V'` when shift is held.
 *
 * Does NOT include the `isTypingTarget` guard — that lives in App
 * because it touches the DOM. This helper only encodes the chord.
 */
export function isValidateShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
  >,
): boolean {
  if (event.altKey) return false;
  if (!event.shiftKey) return false;
  // Exactly one of ctrlKey / metaKey: reject when both are held or
  // both are missing. `===` on booleans is true iff they are equal,
  // i.e. both-true or both-false — both of those mean "not exactly
  // one", so the chord is invalid.
  if (event.ctrlKey === event.metaKey) return false;
  if (typeof event.key !== 'string') return false;
  return event.key.toLowerCase() === 'v';
}

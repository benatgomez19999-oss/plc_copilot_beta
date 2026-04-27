import type { ValidationIssueFilter } from './validation-structure.js';

/**
 * Pure mapping from a keyboard event to a `ValidationIssueFilter` —
 * isolated so App's keydown listener stays one-liner and the helper
 * can be unit-tested without a DOM (the `Pick<KeyboardEvent, …>`
 * parameter accepts plain object literals).
 *
 * Bindings:
 *   `Alt+1` → `'all'`
 *   `Alt+2` → `'error'`
 *   `Alt+3` → `'warning'`
 *   `Alt+4` → `'info'`
 *
 * Returns `null` for any other key. Any modifier other than Alt
 * (Ctrl, Meta, Shift) disqualifies the event so the shortcut never
 * collides with browser / OS chords like `Ctrl+Alt+1`,
 * `Cmd+Alt+1`, or `Shift+Alt+1`.
 */
export function validationFilterForShortcut(
  event: Pick<
    KeyboardEvent,
    'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'
  >,
): ValidationIssueFilter | null {
  if (!event.altKey) return null;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
  switch (event.key) {
    case '1':
      return 'all';
    case '2':
      return 'error';
    case '3':
      return 'warning';
    case '4':
      return 'info';
    default:
      return null;
  }
}

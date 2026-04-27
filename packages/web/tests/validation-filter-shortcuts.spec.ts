import { describe, expect, it } from 'vitest';
import { validationFilterForShortcut } from '../src/utils/validation-filter-shortcuts.js';

/**
 * Test factory — builds the minimal subset of `KeyboardEvent` the
 * helper inspects, so we never have to construct a real DOM event.
 */
function evt(
  key: string,
  modifiers: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
): Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'
> {
  return {
    key,
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  };
}

describe('validationFilterForShortcut — Alt+digit mapping', () => {
  it('1. Alt+1 → all', () => {
    expect(validationFilterForShortcut(evt('1', { altKey: true }))).toBe('all');
  });

  it('2. Alt+2 → error', () => {
    expect(validationFilterForShortcut(evt('2', { altKey: true }))).toBe(
      'error',
    );
  });

  it('3. Alt+3 → warning', () => {
    expect(validationFilterForShortcut(evt('3', { altKey: true }))).toBe(
      'warning',
    );
  });

  it('4. Alt+4 → info', () => {
    expect(validationFilterForShortcut(evt('4', { altKey: true }))).toBe(
      'info',
    );
  });
});

describe('validationFilterForShortcut — modifier guards', () => {
  it('5. plain digit (no Alt) returns null', () => {
    expect(validationFilterForShortcut(evt('1'))).toBeNull();
    expect(validationFilterForShortcut(evt('2'))).toBeNull();
  });

  it('6. Alt + non-digit key (e.g. "l") returns null', () => {
    // Alt+L is reserved for the panel-toggle shortcut (sprint 31).
    expect(validationFilterForShortcut(evt('l', { altKey: true }))).toBeNull();
    expect(validationFilterForShortcut(evt('L', { altKey: true }))).toBeNull();
  });

  it('7. Ctrl+Alt+digit returns null', () => {
    expect(
      validationFilterForShortcut(
        evt('1', { altKey: true, ctrlKey: true }),
      ),
    ).toBeNull();
  });

  it('8. Cmd+Alt+digit (metaKey) returns null', () => {
    expect(
      validationFilterForShortcut(
        evt('2', { altKey: true, metaKey: true }),
      ),
    ).toBeNull();
  });

  it('9. Shift+Alt+digit returns null', () => {
    expect(
      validationFilterForShortcut(
        evt('3', { altKey: true, shiftKey: true }),
      ),
    ).toBeNull();
  });
});

describe('validationFilterForShortcut — out-of-range / non-digit keys', () => {
  it('10. Alt+5 / Alt+9 / Alt+0 return null (only 1-4 are bound)', () => {
    expect(validationFilterForShortcut(evt('0', { altKey: true }))).toBeNull();
    expect(validationFilterForShortcut(evt('5', { altKey: true }))).toBeNull();
    expect(validationFilterForShortcut(evt('9', { altKey: true }))).toBeNull();
  });

  it('11. Alt + arbitrary non-digit returns null', () => {
    expect(validationFilterForShortcut(evt('a', { altKey: true }))).toBeNull();
    expect(
      validationFilterForShortcut(evt('Enter', { altKey: true })),
    ).toBeNull();
    expect(
      validationFilterForShortcut(evt(' ', { altKey: true })),
    ).toBeNull();
  });
});

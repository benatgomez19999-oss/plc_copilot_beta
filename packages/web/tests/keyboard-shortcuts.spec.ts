import { describe, expect, it } from 'vitest';
import { isValidateShortcut } from '../src/utils/keyboard-shortcuts.js';

function evt(
  key: string,
  modifiers: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> {
  return {
    key,
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  };
}

describe('isValidateShortcut — happy paths', () => {
  it('1. Ctrl+Shift+V (Linux / Windows) matches', () => {
    expect(
      isValidateShortcut(evt('v', { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('2. Cmd+Shift+V (macOS) matches', () => {
    expect(
      isValidateShortcut(evt('v', { metaKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('3. uppercase "V" (some layouts emit uppercase when shift is held)', () => {
    expect(
      isValidateShortcut(evt('V', { ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(
      isValidateShortcut(evt('V', { metaKey: true, shiftKey: true })),
    ).toBe(true);
  });
});

describe('isValidateShortcut — modifier guards', () => {
  it('4. Alt blocks the shortcut even with Ctrl+Shift+V', () => {
    expect(
      isValidateShortcut(
        evt('v', { ctrlKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBe(false);
  });

  it('5. missing Shift → false (even with Ctrl+V or Cmd+V)', () => {
    expect(isValidateShortcut(evt('v', { ctrlKey: true }))).toBe(false);
    expect(isValidateShortcut(evt('v', { metaKey: true }))).toBe(false);
  });

  it('6. missing Ctrl AND Meta → false (Shift+V alone doesn\'t fire)', () => {
    expect(isValidateShortcut(evt('v', { shiftKey: true }))).toBe(false);
    expect(isValidateShortcut(evt('v'))).toBe(false);
  });

  it('7. BOTH Ctrl and Meta held → false (must be exactly one)', () => {
    expect(
      isValidateShortcut(
        evt('v', { ctrlKey: true, metaKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });
});

describe('isValidateShortcut — wrong key / wrong type', () => {
  it('8. wrong letter (Ctrl+Shift+B) → false', () => {
    expect(
      isValidateShortcut(evt('b', { ctrlKey: true, shiftKey: true })),
    ).toBe(false);
    expect(
      isValidateShortcut(evt('Enter', { ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it('9. non-string event.key → false (defensive)', () => {
    const bad = {
      key: undefined as unknown as string,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    };
    expect(isValidateShortcut(bad)).toBe(false);
  });
});

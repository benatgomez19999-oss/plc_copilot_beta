/**
 * Best-effort text copy. Tries the modern `navigator.clipboard.writeText`
 * first; falls back to a hidden `<textarea>` + `document.execCommand('copy')`
 * for older browsers and contexts where the Clipboard API is gated by
 * permissions (some iframe / file:// origins).
 *
 * Returns `true` on success, `false` otherwise — never throws. The caller
 * surfaces a "Copied!" / "Copy failed" badge based on the boolean.
 */
export async function copyText(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea path.
    }
  }

  if (typeof document !== 'undefined') {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } finally {
        ta.remove();
      }
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}

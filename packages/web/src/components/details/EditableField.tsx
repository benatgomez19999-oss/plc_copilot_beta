import { useEffect, useState } from 'react';

export interface EditableFieldProps {
  label: string;
  /** Current value from the applied project (may be `undefined` for optional fields). */
  value?: string;
  /** JSONPath the patch will write to, e.g. `$.machines[0].stations[1].name`. */
  jsonPath: string;
  placeholder?: string;
  /**
   * Whether saving an empty / whitespace-only string is allowed.
   * Defaults to `true` (suits `description`, `code_symbol`).
   * Set `false` for required fields (`name`, `display_name`).
   */
  allowEmpty?: boolean;
  /** Called with the current text when the user clicks Save. */
  onPatch: (path: string, value: string) => void;
}

type SaveState = 'idle' | 'saved';
const SAVED_PULSE_MS = 1500;

/**
 * One labelled input + Save button bound to a single JSONPath. Writes to the
 * draft JSON via the parent's `onPatch` callback — this component never
 * touches the applied project directly.
 *
 * Local state tracks two values: the live `text` (controlled input) and
 * `lastSaved` (the text the user last sent through `onPatch`). The Save
 * button is disabled when the live text matches the reference value
 * (lastSaved if a save has happened, otherwise the prop `value`), so
 * accidentally double-clicking after a save is a no-op.
 *
 * When `jsonPath` changes — i.e. the user picked a different node in the
 * structure tree — local state resets so the field reflects the new node's
 * value without any stale "you have unsaved typing" carry-over.
 */
export function EditableField({
  label,
  value,
  jsonPath,
  placeholder,
  allowEmpty = true,
  onPatch,
}: EditableFieldProps): JSX.Element {
  const initial = value ?? '';
  const [text, setText] = useState(initial);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  // Reset whenever the bound path or applied value changes (different node
  // selected, or Apply just promoted the draft so `value` caught up).
  useEffect(() => {
    setText(initial);
    setLastSaved(null);
    setSaveState('idle');
  }, [jsonPath, initial]);

  // The "Save" button compares against this reference, NOT the prop value:
  // after a save the prop is still stale until the user hits Apply, so we
  // remember what we last saved to the draft to keep the button disabled.
  const reference = lastSaved ?? initial;
  const trimmedEmpty = text.trim().length === 0;
  const blockedByEmpty = !allowEmpty && trimmedEmpty;
  const canSave = text !== reference && !blockedByEmpty;

  function handleSave(): void {
    onPatch(jsonPath, text);
    setLastSaved(text);
    setSaveState('saved');
    // The "Saved ✓" pulse — purely cosmetic; the button stays disabled
    // afterwards because text === lastSaved.
    setTimeout(() => setSaveState('idle'), SAVED_PULSE_MS);
  }

  return (
    <div className="editable-field">
      <label className="editable-field-label muted small">{label}</label>
      <div className="editable-field-row">
        <input
          type="text"
          className="editable-field-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <button
          type="button"
          className="btn primary"
          onClick={handleSave}
          disabled={!canSave}
          title={
            canSave
              ? 'Write this value to the draft JSON (Apply to promote it)'
              : blockedByEmpty
                ? 'This field cannot be empty'
                : 'No changes to save'
          }
        >
          {saveState === 'saved' ? 'Saved ✓' : 'Save to draft'}
        </button>
      </div>
    </div>
  );
}

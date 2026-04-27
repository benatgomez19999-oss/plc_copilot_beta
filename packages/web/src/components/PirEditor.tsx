import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { Project, ValidationReport } from '@plccopilot/pir';
import { copyText } from '../utils/clipboard.js';
import { findJsonPathLine } from '../utils/json-locator.js';
import { findJsonPathValueRange } from '../utils/json-range-locator.js';
import {
  clampEditorLine,
  focusToneClassSuffix,
  type PirFocusSeverity,
} from '../utils/monaco-focus.js';
import { configureMonacoLoader } from '../utils/monaco-loader.js';
import { projectToPrettyJson } from '../utils/project-json.js';
import {
  summarizeValidationIssues,
} from '../utils/validation-summary.js';
import {
  draftValidationToMarkers,
  validatePirDraft,
  type EditorMarkerLike,
  type PirDraftValidation,
} from '../utils/pir-draft.js';
import { MonacoDiffReadonly } from './MonacoDiffReadonly.js';

export interface PirEditorProps {
  project: Project;
  fileName?: string;
  validationReport?: ValidationReport | null;
  onApply: (project: Project, rawJson: string) => void;
  /**
   * Controlled draft JSON owned by the parent. The parent is responsible for
   * resyncing this when `project` changes (upload / restore / Apply) and
   * for accepting external patches (visual edits from the structure panel).
   */
  draftJson: string;
  onDraftJsonChange: (next: string) => void;
  /**
   * External request to scroll the editor to a JSONPath. Bumping `nonce`
   * while keeping the same `path` re-triggers the reveal — this is what
   * the PIR Structure navigator uses for its "Find in PIR editor"
   * button. Sprint 29 adds optional `severity`: when supplied (validation
   * cycle clicks), the transient line / value highlight is tinted by
   * tone (`error` → red, `warning` → amber, `info` → blue). Omitting
   * severity (or passing `'neutral'`) keeps the sprint-25/26 blue
   * line + yellow value palette.
   */
  focusRequest?: {
    path: string;
    nonce: number;
    severity?: PirFocusSeverity;
  } | null;
}

type EditorLoadState = 'idle' | 'loading' | 'ready' | 'failed';
type CopyState = 'idle' | 'ok' | 'fail';

const DEBOUNCE_MS = 300;
const LOAD_TIMEOUT_MS = 8_000;
const MARKER_OWNER = 'pir-draft';
/**
 * How long the transient line highlight lingers after a focus jump.
 * Long enough to catch the eye, short enough not to confuse a user
 * who is typing immediately afterwards. Tuned by feel.
 */
const FOCUS_HIGHLIGHT_MS = 1500;

/**
 * Editable Monaco editor for the PIR JSON. The compile pipeline NEVER reads
 * `draftJson` directly — it reads `appliedProject` from the parent. The user
 * promotes the draft to the applied project by clicking **Apply JSON**, and
 * only when the schema validates.
 */
export function PirEditor({
  project,
  fileName,
  validationReport,
  onApply,
  draftJson,
  onDraftJsonChange,
  focusRequest,
}: PirEditorProps): JSX.Element {
  // The applied project's canonical JSON. Used as the baseline to detect
  // dirtiness, drive the diff view, and feed the Reset button.
  const appliedJson = useMemo(() => projectToPrettyJson(project), [project]);

  const [debouncedDraft, setDebouncedDraft] = useState(draftJson);
  const [editorState, setEditorState] = useState<EditorLoadState>('idle');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [showDiff, setShowDiff] = useState(false);

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Live decoration ids and pending fade-out timer for the transient
  // focus-line highlight. Both are mutable refs (not state) — Monaco
  // mutations should never trigger a React re-render, and the timer
  // races we have to handle (new request before the old one fades)
  // are easier to reason about with imperative refs than with effects.
  const focusDecorationIdsRef = useRef<string[]>([]);
  const focusDecorationTimerRef = useRef<number | null>(null);

  // Auto-dismiss the diff view when the parent resyncs draft to applied
  // (Apply / upload / restore) — at that moment there is nothing to diff.
  useEffect(() => {
    if (draftJson === appliedJson) {
      setShowDiff(false);
    }
  }, [draftJson, appliedJson]);

  // Debounce the controlled draft — the validation pipeline runs Zod parse
  // and a domain `validate()`, both of which would lag on per-keystroke runs.
  useEffect(() => {
    if (draftJson === debouncedDraft) return;
    const id = setTimeout(() => setDebouncedDraft(draftJson), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draftJson, debouncedDraft]);

  // Lazy-init Monaco on first mount.
  useEffect(() => {
    if (editorState !== 'idle') return;
    setEditorState('loading');
    let cancelled = false;
    configureMonacoLoader()
      .then(() => loader.init())
      .catch(() => {
        if (!cancelled) setEditorState('failed');
      });
    const t = setTimeout(() => {
      if (cancelled) return;
      setEditorState((prev) => (prev === 'loading' ? 'failed' : prev));
    }, LOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [editorState]);

  const validation = useMemo<PirDraftValidation>(
    () => validatePirDraft(debouncedDraft),
    [debouncedDraft],
  );

  // Sync markers whenever the validation result changes. We pass the
  // live model's line count into `toMonacoMarker` so a stale marker
  // (generated against `debouncedDraft` but applied to the live model
  // a keystroke later) can never reference an out-of-range line.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const lineCount = model.getLineCount();
    const markers = draftValidationToMarkers(validation, debouncedDraft).map(
      (m) => toMonacoMarker(m, monaco, lineCount),
    );
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  }, [validation, debouncedDraft]);

  // External focus requests (from the PIR Structure navigator and the
  // Pending-changes rows). The reveal resolves against the current
  // `draftJson` because that's exactly what Monaco is rendering.
  //
  // Two-tier highlight (sprint 26 builds on sprint 25):
  //   1. Always drop the whole-line decoration + glyph strip — works
  //      even when the value range can't be precisely located, and
  //      gives the user a visible "this is where I landed" cue.
  //   2. Additionally, when `findJsonPathValueRange` resolves the
  //      precise byte range of the JSON value (string body, number
  //      tokens, balanced object/array), drop a second decoration
  //      that highlights ONLY the value characters via
  //      `pir-focus-value-highlight`. The user sees both at once: the
  //      line as context, the value as the precise hit.
  //
  // Both decorations share the same id list and the same fade-out
  // timer. A second `focusRequest` arriving before the first fade-out
  // can atomically replace both (clear old → add new → reset timer)
  // without letting the older timer nuke the newer decorations.
  useEffect(() => {
    if (!focusRequest) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    const lineCount = model?.getLineCount() ?? 1;

    // Try the precise value range first. When successful, its start
    // line is the most accurate scroll target; when it fails we fall
    // back to the line locator (which has its own heuristics for
    // hand-edited JSON).
    const valueRange = findJsonPathValueRange(draftJson, focusRequest.path);
    const rawLine =
      valueRange?.startLineNumber ??
      findJsonPathLine(draftJson, focusRequest.path);
    const line = clampEditorLine(rawLine, lineCount);

    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();

    if (focusDecorationTimerRef.current !== null) {
      window.clearTimeout(focusDecorationTimerRef.current);
      focusDecorationTimerRef.current = null;
    }

    // Sprint 29 — tint the transient highlight by severity when the
    // jump came from a validation cycle. Suffix is empty for neutral
    // (sprint-25/26 default), `-error` / `-warning` / `-info` otherwise.
    // We always include the base class so shared geometry (border
    // radius, transitions) is preserved; the suffix class layers
    // colour overrides on top.
    const toneSuffix = focusToneClassSuffix(focusRequest.severity);
    const lineClass = toneSuffix
      ? `pir-focus-line-highlight pir-focus-line-highlight${toneSuffix}`
      : 'pir-focus-line-highlight';
    const glyphClass = toneSuffix
      ? `pir-focus-glyph-highlight pir-focus-glyph-highlight${toneSuffix}`
      : 'pir-focus-glyph-highlight';
    const valueClass = toneSuffix
      ? `pir-focus-value-highlight pir-focus-value-highlight${toneSuffix}`
      : 'pir-focus-value-highlight';

    const decorations: MonacoEditor.IModelDeltaDecoration[] = [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: lineClass,
          linesDecorationsClassName: glyphClass,
        },
      },
    ];

    if (valueRange) {
      // Defensive clamps: stale paths against a freshly-shrunk draft
      // can produce out-of-range numbers; Monaco asserts on those, so
      // we pin every corner into the live model's bounds.
      decorations.push({
        range: new monaco.Range(
          clampEditorLine(valueRange.startLineNumber, lineCount),
          Math.max(1, Math.floor(valueRange.startColumn)),
          clampEditorLine(valueRange.endLineNumber, lineCount),
          Math.max(1, Math.floor(valueRange.endColumn)),
        ),
        options: {
          inlineClassName: valueClass,
        },
      });
    }

    focusDecorationIdsRef.current = editor.deltaDecorations(
      focusDecorationIdsRef.current,
      decorations,
    );

    focusDecorationTimerRef.current = window.setTimeout(() => {
      focusDecorationTimerRef.current = null;
      const liveEditor = editorRef.current;
      if (!liveEditor) return;
      focusDecorationIdsRef.current = liveEditor.deltaDecorations(
        focusDecorationIdsRef.current,
        [],
      );
    }, FOCUS_HIGHLIGHT_MS);

    // `nonce` is part of the dependency list so re-clicking the same
    // node still scrolls + replays the highlight (otherwise React
    // de-dupes the `path` and skips us).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.path, focusRequest?.nonce]);

  // Final cleanup on unmount — clear the timer and any lingering
  // decorations. `editor.deltaDecorations` is a no-op when the model
  // has been disposed, but we still guard so disposed editors don't
  // throw.
  useEffect(() => {
    return () => {
      if (focusDecorationTimerRef.current !== null) {
        window.clearTimeout(focusDecorationTimerRef.current);
        focusDecorationTimerRef.current = null;
      }
      const editor = editorRef.current;
      if (editor && focusDecorationIdsRef.current.length > 0) {
        editor.deltaDecorations(focusDecorationIdsRef.current, []);
      }
      focusDecorationIdsRef.current = [];
    };
  }, []);

  const isDirty = draftJson !== appliedJson;
  const canApply = isDirty && validation.status === 'valid';

  const lineCount = draftJson.split('\n').length;
  const charCount = draftJson.length;

  async function handleCopy(): Promise<void> {
    const ok = await copyText(draftJson);
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  }

  function handleReset(): void {
    onDraftJsonChange(appliedJson);
    setDebouncedDraft(appliedJson);
  }

  function handleApply(): void {
    if (validation.status !== 'valid') return;
    onApply(validation.project, draftJson);
  }

  return (
    <section className="card pir-editor">
      <header className="panel-header">
        <div>
          <h2>PIR JSON (editable)</h2>
          <p className="muted">
            {fileName ? (
              <>
                file: <code>{fileName}</code> ·{' '}
              </>
            ) : null}
            {lineCount} lines · {charCount.toLocaleString()} chars ·{' '}
            <StatusPill validation={validation} isDirty={isDirty} />
          </p>
        </div>
        <div className="preview-actions">
          <button
            type="button"
            className="btn"
            onClick={handleCopy}
            title="Copy the entire draft JSON to clipboard"
          >
            {copyState === 'idle'
              ? 'Copy JSON'
              : copyState === 'ok'
                ? 'Copied ✓'
                : 'Copy failed'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setShowDiff((s) => !s)}
            disabled={!isDirty}
            title={
              isDirty
                ? 'Compare the unsaved draft against the applied JSON'
                : 'No unsaved changes to diff'
            }
          >
            {showDiff ? 'Hide diff' : 'Show diff'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleReset}
            disabled={!isDirty}
            title="Discard the unsaved draft and revert to the applied JSON"
          >
            Reset to applied
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleApply}
            disabled={!canApply}
            title={
              canApply
                ? 'Replace the working project with the draft JSON'
                : isDirty
                  ? 'Fix JSON / schema errors before applying'
                  : 'No unsaved changes'
            }
          >
            Apply JSON
          </button>
        </div>
      </header>

      <DraftStatusPanel
        validation={validation}
        appliedReport={validationReport ?? null}
        isDirty={isDirty}
      />

      {showDiff && isDirty ? (
        <MonacoDiffReadonly
          original={appliedJson}
          modified={draftJson}
          language="json"
          height="50vh"
          fallbackLabel="Diff editor unavailable — falling back to a side-by-side plain text view."
        />
      ) : editorState === 'failed' ? (
        <>
          <p className="muted small">
            Editor unavailable — switch to a recent browser to edit the PIR
            JSON. The artifact preview keeps working in plain-text mode.
          </p>
          <pre className="content">{draftJson}</pre>
        </>
      ) : (
        <div className="editor-container">
          <Editor
            height="50vh"
            language="json"
            value={draftJson}
            theme="vs-dark"
            onChange={(value) => onDraftJsonChange(value ?? '')}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
              setEditorState('ready');
            }}
            loading={
              <pre className="content content-loading">{draftJson}</pre>
            }
            options={{
              readOnly: false,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              automaticLayout: true,
              fontSize: 13,
              lineNumbers: 'on',
              tabSize: 2,
              insertSpaces: true,
              renderWhitespace: 'selection',
              folding: true,
              smoothScrolling: true,
              contextmenu: true,
              formatOnPaste: false,
              formatOnType: false,
              quickSuggestions: false,
              scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
              },
            }}
          />
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function toMonacoMarker(
  m: EditorMarkerLike,
  monaco: Monaco,
  lineCount: number,
): MonacoEditor.IMarkerData {
  // Defensive clamp: if the marker was generated for a slightly older
  // version of the document (debounce window), its corners may fall
  // outside the live model. Pin them in. Same-line markers must have
  // endColumn > startColumn or Monaco won't render a visible width.
  const startLine = clampEditorLine(m.startLineNumber, lineCount);
  const endLine = clampEditorLine(m.endLineNumber, lineCount);
  const startCol = Math.max(1, Math.floor(m.startColumn));
  let endCol = Math.max(1, Math.floor(m.endColumn));
  if (startLine === endLine && endCol <= startCol) {
    endCol = startCol + 1;
  }
  return {
    severity:
      m.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : m.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
    message: m.message,
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: endLine,
    endColumn: endCol,
  };
}

function StatusPill({
  validation,
  isDirty,
}: {
  validation: PirDraftValidation;
  isDirty: boolean;
}): JSX.Element {
  if (!isDirty) {
    return <span className="badge sev-info">Clean</span>;
  }
  switch (validation.status) {
    case 'invalid-json':
      return <span className="badge sev-error">Invalid JSON</span>;
    case 'invalid-schema':
      return <span className="badge sev-error">Invalid PIR schema</span>;
    case 'valid': {
      const errors = validation.report.issues.filter(
        (i) => i.severity === 'error',
      ).length;
      return errors > 0 ? (
        <span className="badge sev-warning">
          Unsaved · {errors} validation error{errors === 1 ? '' : 's'}
        </span>
      ) : (
        <span className="badge sev-warning">Unsaved changes</span>
      );
    }
  }
}

function DraftStatusPanel({
  validation,
  appliedReport,
  isDirty,
}: {
  validation: PirDraftValidation;
  appliedReport: ValidationReport | null;
  isDirty: boolean;
}): JSX.Element | null {
  if (validation.status === 'invalid-json') {
    return (
      <div className="banner banner-error">
        <strong>
          Invalid JSON
          {validation.line ? ` (line ${validation.line})` : ''}:
        </strong>
        <pre>{validation.message}</pre>
      </div>
    );
  }
  if (validation.status === 'invalid-schema') {
    const head = validation.issues.slice(0, 5);
    const more = validation.issues.length - head.length;
    return (
      <div className="banner banner-error">
        <strong>
          PIR schema mismatch ({validation.issues.length} issue
          {validation.issues.length === 1 ? '' : 's'}):
        </strong>
        <ul>
          {head.map((i, k) => (
            <li key={k}>
              <code>{i.path || '(root)'}</code>: {i.message}
            </li>
          ))}
          {more > 0 ? (
            <li className="muted">… +{more} more (see editor markers)</li>
          ) : null}
        </ul>
      </div>
    );
  }

  // status === 'valid' — schema OK; surface domain validate() issues if any.
  const issues = isDirty ? validation.report.issues : (appliedReport?.issues ?? []);
  if (issues.length === 0) return null;

  const counts = summarizeValidationIssues(issues);
  return (
    <div className="banner banner-info">
      <strong>
        {isDirty ? 'Draft validation' : 'Applied validation'}: {counts.errors}{' '}
        errors, {counts.warnings} warnings, {counts.info} info.
      </strong>
      {' '}
      Apply is allowed; consider fixing before generating.
    </div>
  );
}

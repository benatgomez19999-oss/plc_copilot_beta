import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@plccopilot/pir';
import {
  validate,
  type Issue,
  type ValidationReport,
} from '@plccopilot/pir';
import type {
  ArtifactDiagnostic,
  GeneratedArtifact,
} from '@plccopilot/codegen-core';
import {
  type BackendChoice,
  type CompileResult,
} from './compiler/compile.js';
import {
  createCompileWorkerClient,
  type CompileClient,
} from './worker/client.js';
import { Toolbar } from './components/Toolbar.js';
import { FileUpload } from './components/FileUpload.js';
import { BackendSelector } from './components/BackendSelector.js';
import { ProjectSummary } from './components/ProjectSummary.js';
import { PirEditor } from './components/PirEditor.js';
import { PirStructureTree } from './components/PirStructureTree.js';
import { PirStructureDetails } from './components/PirStructureDetails.js';
import { ValidationIssuesList } from './components/ValidationIssuesList.js';
import {
  StructureViewModeToggle,
  type StructureViewMode,
} from './components/StructureViewModeToggle.js';
import { DiagnosticsPanel } from './components/DiagnosticsPanel.js';
import { ArtifactTree } from './components/ArtifactTree.js';
import { ArtifactPreview } from './components/ArtifactPreview.js';
import { DropZone } from './components/DropZone.js';
import {
  downloadArtifactBundle,
  downloadArtifactsZip,
} from './utils/download.js';
import {
  clearOpenValidationPanel,
  clearSavedProject,
  clearValidationReport,
  loadOpenValidationPanel,
  loadSavedProject,
  loadValidationIssueFilter,
  loadValidationReport,
  saveOpenValidationPanel,
  saveProject,
  saveValidationIssueFilter,
  saveValidationReport,
} from './utils/storage.js';
import { validationFilterForShortcut } from './utils/validation-filter-shortcuts.js';
import { isValidateShortcut } from './utils/keyboard-shortcuts.js';
import {
  countValidationReportIssues,
  restoredValidationReportMessage,
  validationReportTone,
  type ValidationReportTone,
} from './utils/validation-report-summary.js';
import {
  formatSerializedCompilerError,
  serializeCompilerError,
  type SerializedCompilerError,
} from '@plccopilot/codegen-core';
import { CompileClientError } from './worker/client.js';
import { selectBestArtifact } from './utils/artifact-selection.js';
import { diagnosticsFromGeneratedArtifacts } from './utils/diagnostics.js';
import { isPirJsonPath, splitErrorCodePrefix } from './utils/error-display.js';
import { buildWebZipSummary } from './utils/web-summary.js';
import { findPreviousArtifact } from './utils/artifact-diff.js';
import { readProjectFromFile } from './utils/read-file.js';
import {
  buildPirStructure,
  findPirStructureNodeByPath,
  flattenPirStructure,
} from './utils/pir-structure.js';
import { setJsonPathValue } from './utils/json-patch.js';
import { projectToPrettyJson } from './utils/project-json.js';
import { getDraftProjectState } from './utils/draft-project-state.js';
import { preserveOrClearSelection } from './utils/structure-selection.js';
import { diffPirValues, type PirDiffEntry } from './utils/pir-diff.js';
import {
  changedDescendantPaths,
  structureChangeBreakdownsFromDiffs,
  structureChangeCountsFromDiffs,
  type StructureChangeBreakdown,
} from './utils/structure-diff.js';
import {
  sortValidationIssueListItems,
  validationIssueBreakdownsFromReport,
  validationIssueCountsFromReport,
  validationIssueDescendants,
  validationIssuesForNode,
  type ValidationIssueFilter,
  type ValidationSeverityBreakdown,
} from './utils/validation-structure.js';
import type { PirFocusSeverity } from './utils/monaco-focus.js';

function validationIssuesAsArtifactDiagnostics(
  report: ValidationReport | null,
): ArtifactDiagnostic[] {
  if (!report) return [];
  return report.issues.map((i) => ({
    code: i.rule,
    severity: i.severity,
    message: i.message,
    path: i.path,
  }));
}

/**
 * Sprint 31 — should the global keyboard shortcut be ignored because
 * the user is typing? Returns `true` when the event target is an
 * `<input>` / `<textarea>` / `<select>`, an element with
 * `contentEditable`, or any element inside a Monaco editor. Anything
 * else is treated as "background" and the shortcut fires.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest('.monaco-editor')) return true;
  return false;
}

/**
 * Build the `applyNote` text shown after a successful Apply. Sprint 29
 * makes Apply a "promote and validate" action, so the banner reflects
 * the new `validationReport` immediately:
 *
 *   - report.ok        → "Applied JSON changes. Validation passed."
 *   - report.ok=false  → "Applied JSON changes. Validation found 2 errors,
 *                         1 warning, 0 info."
 *
 * The example in the sprint spec keeps zero-buckets visible
 * (`0 info`) so the banner shape is stable across reports — easier to
 * scan than a length-varying phrase.
 */
function applyNoteForReport(report: ValidationReport): string {
  if (report.ok) return 'Applied JSON changes. Validation passed.';
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const i of report.issues) {
    if (i.severity === 'error') errors++;
    else if (i.severity === 'warning') warnings++;
    else if (i.severity === 'info') info++;
  }
  return `Applied JSON changes. Validation found ${errors} error${
    errors === 1 ? '' : 's'
  }, ${warnings} warning${warnings === 1 ? '' : 's'}, ${info} info.`;
}

/**
 * Tooltip text for a disabled Draft tab. Distinguishes between "draft
 * matches applied" (no point switching) and "draft is invalid" (with the
 * resolver's first message) so the user knows which knob to turn.
 */
function draftViewIssue(state: ReturnType<typeof getDraftProjectState>): string {
  if (state.kind === 'same-as-applied') {
    return 'Draft matches the applied project — nothing distinct to view.';
  }
  if (state.kind === 'invalid') {
    return state.reason === 'json'
      ? `Draft has invalid JSON: ${state.message}`
      : `Draft fails the PIR schema: ${state.message}`;
  }
  return '';
}

export default function App(): JSX.Element {
  // The "applied" project is the only thing the compile pipeline reads.
  // The PIR editor maintains its own internal `draftJson`; until the user
  // hits Apply, edits never reach Generate / Validate.
  const [appliedProject, setAppliedProject] = useState<Project | null>(null);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const [dropInfo, setDropInfo] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendChoice>('siemens');
  const [validationReport, setValidationReport] =
    useState<ValidationReport | null>(null);
  // Sprint 34 / 35 — informational banner shown after a project load
  // when its validation report came back from localStorage. Carries
  // a severity tone (error / warning / info) so the banner colour
  // matches the dominant issue level of the cached report. Cleared
  // by Validate / Apply (which produce fresh reports), Discard, or
  // the next project load.
  const [validationRestoreNote, setValidationRestoreNote] = useState<
    { tone: ValidationReportTone; message: string } | null
  >(null);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [previousCompileResult, setPreviousCompileResult] =
    useState<CompileResult | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  // Sprint 43 — structured shadow of `compileError` so the banner
  // can show a "Jump to PIR" button when the underlying error
  // carries a real `machines[…]…` JSON path. We keep the
  // pre-formatted string for the existing single-line render, AND
  // the structured shape for the action wiring.
  const [compileErrorDetails, setCompileErrorDetails] =
    useState<SerializedCompilerError | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [workerNote, setWorkerNote] = useState<string | null>(null);
  const [artifactsStale, setArtifactsStale] = useState(false);
  // PIR structure navigator selection + focus pulse for the editor. The nonce
  // is what guarantees re-clicks of the same node still scroll the editor.
  const [selectedNodeJsonPath, setSelectedNodeJsonPath] = useState<
    string | null
  >(null);
  const [pirFocusRequest, setPirFocusRequest] = useState<{
    path: string;
    nonce: number;
    severity: PirFocusSeverity;
  } | null>(null);

  // Sprint 34 — when Alt+L opens the validation panel, we ask the
  // panel to focus its first row. Mouse `⋯` clicks intentionally
  // do NOT bump this nonce, so they never steal focus from the
  // structure tree the user just clicked. The nonce-based shape
  // mirrors the `pirFocusRequest` pattern from sprint 25.
  const [validationPanelFocusRequest, setValidationPanelFocusRequest] =
    useState<{ nodePath: string; nonce: number } | null>(null);
  const validationPanelFocusNonceRef = useRef(0);

  // Controlled PIR draft JSON, lifted out of PirEditor so the visual-edit
  // flow (structure-panel patches) can write to it without a ref hack. The
  // applied project remains the only thing Generate / Validate ever read.
  const [draftJson, setDraftJson] = useState<string>('');
  const [visualEditNote, setVisualEditNote] = useState<string | null>(null);
  const [visualEditError, setVisualEditError] = useState<string | null>(null);

  // Structure navigator view mode. `applied` mirrors what Generate sees;
  // `draft` lets the user inspect their unsaved edits in the same tree
  // without changing any compile semantics. Default is `applied` so a
  // freshly-loaded project never opens in a state it can't be generated
  // from.
  const [structureViewMode, setStructureViewMode] =
    useState<StructureViewMode>('applied');
  // Surfaced when we auto-fall back from Draft to Applied because the
  // draft became invalid; cleared on manual mode change or when the
  // draft becomes valid again.
  const [structureFallbackWarning, setStructureFallbackWarning] = useState<
    string | null
  >(null);
  // Surfaced when a tree rebuild (mode toggle / draft swap) drops the
  // user's current selection. Cleared when the user picks a new node.
  const [structureSelectionNote, setStructureSelectionNote] = useState<
    string | null
  >(null);

  // Resync draft → applied whenever the parent swaps in a new project
  // (file load, drop, restore, Apply). The PirEditor used to do this
  // internally; lifting the state means we own that contract here.
  useEffect(() => {
    if (appliedProject) {
      setDraftJson(projectToPrettyJson(appliedProject));
    } else {
      setDraftJson('');
    }
    setVisualEditNote(null);
    setVisualEditError(null);
    // After Apply / load / restore the draft equals the applied — there
    // is no distinct draft to view, so reset the toggle to its default.
    setStructureViewMode('applied');
    setStructureFallbackWarning(null);
    setStructureSelectionNote(null);
    // Close any open validation-issues list — its node may not exist
    // under the new project anyway, and the auto-close effect would
    // close it on the next render. Doing it here is just immediate.
    // NOTE: we do NOT call `saveOpenValidationPanel(null)` here so
    // the persisted marker survives the project transition; the
    // sprint-33 restore effect below will validate the saved path
    // against the new project's tree + issues and either reopen or
    // clear the entry.
    setOpenValidationIssues(null);
    // Sprint 33 — reset the once-per-project restore guard so the
    // newly-loaded / restored project gets a fresh restore attempt.
    hasRestoredOpenValidationPanelRef.current = false;
  }, [appliedProject]);

  // ---- Worker client (created once, terminated on unmount) ----
  const clientRef = useRef<CompileClient | null>(null);
  useEffect(() => {
    const client = createCompileWorkerClient();
    clientRef.current = client;
    if (!client.available) {
      setWorkerNote(
        client.fallbackReason ??
          'Web Worker unavailable; compiling on main thread.',
      );
    }
    return () => {
      client.terminate();
      clientRef.current = null;
    };
  }, []);

  // ---- Restore from localStorage on mount ----
  useEffect(() => {
    const result = loadSavedProject();
    if (result.ok) {
      setAppliedProject(result.project);
      setFileName(result.saved.fileName);
      const ts = new Date(result.saved.loadedAt).toLocaleString();
      setRestoreNote(
        `Restored from local browser storage — "${result.saved.fileName}" (${ts}).`,
      );
      // Sprint 34 — also try to rehydrate the saved validation
      // report so the navigator panel can reopen immediately
      // without requiring the user to click Validate first.
      tryRestoreValidationReport(result.project);
    } else if (result.reason !== 'no saved project') {
      // Surface stale-cleared / unavailable storage as a non-fatal note.
      setRestoreNote(`Note: ${result.reason}`);
    }
  }, []);

  const selectedArtifact: GeneratedArtifact | null = useMemo(() => {
    if (!compileResult || !selectedPath) return null;
    return (
      compileResult.artifacts.find((a) => a.path === selectedPath) ?? null
    );
  }, [compileResult, selectedPath]);

  // Same-path artifact from the previous generation (when one exists).
  // Drives the "Show diff with previous" button in ArtifactPreview.
  const previousArtifact: GeneratedArtifact | null = useMemo(() => {
    if (!selectedArtifact || !previousCompileResult) return null;
    return findPreviousArtifact(
      selectedArtifact.path,
      previousCompileResult.artifacts,
    );
  }, [selectedArtifact, previousCompileResult]);

  const validationDiagnostics = useMemo(
    () => validationIssuesAsArtifactDiagnostics(validationReport),
    [validationReport],
  );

  // Sprint 44 — aggregate ALL diagnostics surfaced by the last
  // generation: per-artifact `.diagnostics` AND the manifest's
  // `compiler_diagnostics` array (parsed lazily from the manifest
  // artifact's content). Deduped so a diagnostic that appears on
  // both surfaces doesn't double-count.
  const compilerDiagnosticsForPanel = useMemo(
    () =>
      compileResult
        ? diagnosticsFromGeneratedArtifacts(compileResult.artifacts)
        : [],
    [compileResult],
  );

  // Sprint 44 — wire each row's "Jump" button into the existing
  // PIR focus pipeline. Severity maps directly: error/warning/info
  // are also valid `PirFocusSeverity` values, so the highlight tint
  // matches the diagnostic tone.
  const handleJumpFromDiagnosticRow = useCallback(
    (path: string, severity: ArtifactDiagnostic['severity']): void => {
      handleFocusInEditor(path, severity);
    },
    [],
  );

  // Derived draft project state — the single source of truth for "is the
  // draft viewable?". Reuses validatePirDraft so we don't duplicate parse /
  // Zod / domain-validate logic. Memoized on the draft text + applied
  // project so swapping projects or typing in Monaco both invalidate it.
  const draftProjectState = useMemo(
    () => getDraftProjectState(draftJson, appliedProject),
    [draftJson, appliedProject],
  );

  // The project actually displayed by the structure tree + detail card.
  // Visual edits patch `draftJson` regardless of mode; the only thing
  // that changes between modes is which project the navigator resolves
  // against. Generate / Validate keep reading `appliedProject` directly,
  // so this never affects compile semantics.
  const viewProject: Project | null = useMemo(() => {
    if (
      structureViewMode === 'draft' &&
      draftProjectState.kind === 'valid'
    ) {
      return draftProjectState.project;
    }
    return appliedProject;
  }, [structureViewMode, draftProjectState, appliedProject]);

  const pirStructureTree = useMemo(
    () => (viewProject ? buildPirStructure(viewProject) : null),
    [viewProject],
  );
  const pirStructureFlat = useMemo(
    () => (pirStructureTree ? flattenPirStructure(pirStructureTree) : []),
    [pirStructureTree],
  );
  const selectedStructureNode = useMemo(() => {
    if (!selectedNodeJsonPath) return null;
    return (
      pirStructureFlat.find((n) => n.jsonPath === selectedNodeJsonPath) ?? null
    );
  }, [pirStructureFlat, selectedNodeJsonPath]);

  // Visual diff between applied and the (valid) draft. We only compute a
  // non-empty diff when the draft differs and parses cleanly — otherwise
  // the navigator shows no dots and the detail card hides Pending changes.
  // Generate / Validate are completely independent of this; they keep
  // reading `appliedProject` directly.
  const pirDiffs = useMemo<PirDiffEntry[]>(() => {
    if (draftProjectState.kind !== 'valid' || !appliedProject) return [];
    return diffPirValues(appliedProject, draftProjectState.project);
  }, [draftProjectState, appliedProject]);

  // Per-node count `Map<jsonPath, n>` — drives the `● N` pills in the tree.
  // Computed from the same `pirDiffs` so counts can never disagree with the
  // dot membership.
  const structureChangeCounts = useMemo<ReadonlyMap<string, number>>(
    () => structureChangeCountsFromDiffs(pirDiffs),
    [pirDiffs],
  );

  // Per-node breakdown `Map<jsonPath, { total, added, removed, changed }>`.
  // Drives the badge tooltip / aria so the user can see *what kind* of
  // change is pending under a branch without entering the detail card.
  // Visible badge stays at `● N`; this only enriches metadata.
  const structureChangeBreakdowns = useMemo<
    ReadonlyMap<string, StructureChangeBreakdown>
  >(() => structureChangeBreakdownsFromDiffs(pirDiffs), [pirDiffs]);

  // Source-aware validation issue list — drives the `⚠ N` badge.
  //   Applied view → `validationReport?.issues` (empty until the user
  //                  clicks Validate at least once).
  //   Draft view   → `draftProjectState.report.issues` when the draft
  //                  is schema-valid; otherwise [] because the editor
  //                  markers already surface JSON / Zod errors.
  // Generate / Validate stay coupled to `appliedProject` only — this
  // memo is purely cosmetic, never feeds the compile pipeline.
  const structureValidationIssues = useMemo<readonly Issue[]>(() => {
    if (structureViewMode === 'draft') {
      return draftProjectState.kind === 'valid'
        ? draftProjectState.report.issues
        : [];
    }
    return validationReport?.issues ?? [];
  }, [structureViewMode, draftProjectState, validationReport]);

  const validationCounts = useMemo<ReadonlyMap<string, number>>(
    () => validationIssueCountsFromReport(structureValidationIssues),
    [structureValidationIssues],
  );

  const validationBreakdowns = useMemo<
    ReadonlyMap<string, ValidationSeverityBreakdown>
  >(
    () => validationIssueBreakdownsFromReport(structureValidationIssues),
    [structureValidationIssues],
  );

  // Back-compat: still expose the Set for any code that wants membership-only
  // semantics. Derived from the same map keys so the two are consistent by
  // construction.
  const changedStructurePaths = useMemo<ReadonlySet<string>>(
    () => new Set(structureChangeCounts.keys()),
    [structureChangeCounts],
  );

  // Auto-fallback: if Draft mode was active and the draft just became
  // invalid (or matches applied again), pop the toggle back to Applied
  // and surface a clear warning. Manual mode changes clear the warning
  // via `handleStructureModeChange`.
  useEffect(() => {
    if (structureViewMode !== 'draft') return;
    if (draftProjectState.kind === 'valid') return;
    setStructureViewMode('applied');
    if (draftProjectState.kind === 'invalid') {
      const reason =
        draftProjectState.reason === 'json'
          ? 'JSON parse error'
          : draftProjectState.message;
      setStructureFallbackWarning(
        `Draft is invalid (${reason}); structure view switched back to Applied.`,
      );
    }
    // The `same-as-applied` case is silent — there is simply nothing
    // distinct to view, no warning needed.
  }, [structureViewMode, draftProjectState]);

  // Selection-validity guard: if the tree rebuilt and the user's
  // previously selected path no longer exists in the new tree, clear it
  // and surface a one-line note. The note is sticky until the user
  // picks a new node (cleared in `handleStructureSelect`).
  useEffect(() => {
    if (!pirStructureTree) return;
    if (selectedNodeJsonPath === null) return;
    const next = preserveOrClearSelection(
      pirStructureTree,
      selectedNodeJsonPath,
    );
    if (next === null) {
      setSelectedNodeJsonPath(null);
      setStructureSelectionNote(
        `Selected node does not exist in the ${structureViewMode} view.`,
      );
    }
  }, [pirStructureTree, selectedNodeJsonPath, structureViewMode]);

  function handleFocusInEditor(
    jsonPath: string,
    severity: PirFocusSeverity = 'neutral',
  ): void {
    // Bump the nonce so re-clicking the same node still re-scrolls
    // Monaco. `severity` defaults to `'neutral'` so every existing
    // single-arg caller (Find in PIR editor, FieldDiff click,
    // change-badge cycle) keeps the sprint-25/26 blue/yellow highlight.
    // Only the validation cycle (sprint 29) passes a non-neutral
    // severity to switch the highlight palette to the issue colour.
    setPirFocusRequest((prev) => ({
      path: jsonPath,
      severity,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }

  // Per-node click counter for the structure tree's `● N` badge cycle.
  // Stored in a ref (NOT state) so a click never triggers a tree
  // re-render — for projects with many nodes this matters. The counter
  // grows unbounded but the lookup uses `counter % paths.length`, so
  // overflow is impossible in any realistic session.
  const badgeCycleRef = useRef<Map<string, number>>(new Map());

  // Whenever the diff list changes (user typed something, applied
  // something, undid an edit, loaded a new project), every cycle
  // counter is stale — drop them all so the next click on each badge
  // restarts at the first descendant change.
  useEffect(() => {
    badgeCycleRef.current.clear();
  }, [pirDiffs]);

  // Tree-badge cycle handler: click N → scroll to the N-th change under
  // the node, looping back to the first when we run out. The badge sees
  // only `(nodePath: string) => void`; everything diff-related stays
  // here in App.
  const handleFocusNextStructureChange = useCallback(
    (nodePath: string): void => {
      const paths = changedDescendantPaths(nodePath, pirDiffs);
      if (paths.length === 0) return;
      const counter = badgeCycleRef.current.get(nodePath) ?? 0;
      const index = counter % paths.length;
      badgeCycleRef.current.set(nodePath, counter + 1);
      handleFocusInEditor(paths[index]!);
    },
    [pirDiffs],
  );

  // Per-node click counter for the validation badge cycle. Independent
  // of the diff cycle ref so the two badges' cycles don't interfere.
  // Reset whenever the active validation report changes (Validate
  // pressed, draft mode toggled, draft becomes valid / invalid, project
  // swapped) — same lifecycle pattern as `badgeCycleRef`.
  const validationCycleRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    validationCycleRef.current.clear();
  }, [structureValidationIssues]);

  const handleFocusNextValidationIssue = useCallback(
    (nodePath: string): void => {
      const targets = validationIssueDescendants(
        nodePath,
        structureValidationIssues,
      );
      if (targets.length === 0) return;
      const counter = validationCycleRef.current.get(nodePath) ?? 0;
      const target = targets[counter % targets.length]!;
      validationCycleRef.current.set(nodePath, counter + 1);
      // Pass the issue's severity through to the focus pulse so Monaco
      // tints the line / value highlight by tone (red / amber / blue).
      // `Issue.severity` is structurally a subset of
      // `PirFocusSeverity` (it omits 'neutral') — TypeScript checks this.
      handleFocusInEditor(target.path, target.severity);
    },
    [structureValidationIssues],
  );

  // Sprint 30 / 31 — inline `ValidationIssuesList` panel. Independent
  // of the `⚠ N` cycle: the cycle button advances issue-by-issue, the
  // list button surfaces the full list under a node so the user can
  // scan, filter by severity, and Jump out of order.
  //
  // Sprint 31 narrows the state shape to just `{ nodePath }`. The
  // node label is derived freshly from the live structure tree on
  // every render, so renaming a node while the panel is open updates
  // the header text without reopening.
  const [openValidationIssues, setOpenValidationIssues] = useState<
    { nodePath: string } | null
  >(null);
  // Sprint 33 — restore-once-per-project guard. Resets in the
  // `appliedProject` effect (see above) and is consumed by the
  // restore effect further down. Declared here so both can see it.
  const hasRestoredOpenValidationPanelRef = useRef(false);

  // Look up the open node in the live flat list. Returns null if the
  // node has been removed from the tree (project swap, schema-failing
  // draft) — the auto-close effect below acts on that.
  const openValidationIssueNode = useMemo(() => {
    if (!openValidationIssues) return null;
    return findPirStructureNodeByPath(
      pirStructureFlat,
      openValidationIssues.nodePath,
    );
  }, [pirStructureFlat, openValidationIssues]);

  const openValidationIssueItems = useMemo(() => {
    if (!openValidationIssues) return [];
    return sortValidationIssueListItems(
      validationIssuesForNode(
        openValidationIssues.nodePath,
        structureValidationIssues,
      ),
    );
  }, [openValidationIssues, structureValidationIssues]);

  // Auto-close in two cases:
  //   1. The open node no longer exists in the structure tree (project
  //      swap, draft schema break, ...).
  //   2. The active issue source has zero issues for that node (Apply
  //      cleared them, view-mode flip changed source).
  // Active filter chip having zero matches is NOT a close trigger —
  // that's intentional, the panel stays open so the user can flip
  // chips without re-opening from the tree.
  //
  // Sprint 33 / 34 — pair the close with a project-scoped clear so
  // the persisted marker doesn't survive a stale-node close.
  useEffect(() => {
    if (!openValidationIssues) return;
    if (!appliedProject) return;
    const exists =
      findPirStructureNodeByPath(
        pirStructureFlat,
        openValidationIssues.nodePath,
      ) !== null;
    const items = validationIssuesForNode(
      openValidationIssues.nodePath,
      structureValidationIssues,
    );
    if (!exists || items.length === 0) {
      setOpenValidationIssues(null);
      clearOpenValidationPanel(appliedProject.id);
    }
  }, [
    openValidationIssues,
    pirStructureFlat,
    structureValidationIssues,
    appliedProject,
  ]);

  // Toggle: same node closes, different node replaces. Label is
  // derived elsewhere so the handler signature is path-only.
  //
  // Sprint 33 pairs every state mutation with a persistence call so
  // the panel restores on next session. Sprint 34 makes that
  // persistence project-scoped — `saveOpenValidationPanel` /
  // `clearOpenValidationPanel` now require a `projectId`, so the
  // callback closes over `appliedProject` and bails when no project
  // is loaded (the `⋯` button can't render without one anyway, but
  // defensive).
  const handleOpenValidationIssues = useCallback(
    (nodePath: string): void => {
      if (!appliedProject) return;
      const projectId = appliedProject.id;
      setOpenValidationIssues((prev) => {
        const next = prev && prev.nodePath === nodePath ? null : { nodePath };
        if (next) {
          saveOpenValidationPanel(projectId, next.nodePath);
        } else {
          clearOpenValidationPanel(projectId);
        }
        return next;
      });
    },
    [appliedProject],
  );

  // Sprint 34 — Alt+L variant. Same toggle semantics, but ALSO bumps
  // a focus-request nonce when opening so `ValidationIssuesList`
  // moves focus to the first visible row. Mouse `⋯` clicks use the
  // plain `handleOpenValidationIssues` above and never bump the
  // nonce — clicking somewhere should not steal focus.
  const handleOpenValidationIssuesAndFocus = useCallback(
    (nodePath: string): void => {
      if (!appliedProject) return;
      const projectId = appliedProject.id;
      setOpenValidationIssues((prev) => {
        const next = prev && prev.nodePath === nodePath ? null : { nodePath };
        if (next) {
          saveOpenValidationPanel(projectId, next.nodePath);
          // Bump the focus nonce inside the same updater so the
          // panel-state and focus-request updates land in one render
          // batch.
          setValidationPanelFocusRequest({
            nodePath: next.nodePath,
            nonce: ++validationPanelFocusNonceRef.current,
          });
        } else {
          clearOpenValidationPanel(projectId);
        }
        return next;
      });
    },
    [appliedProject],
  );

  const handleCloseValidationIssues = useCallback((): void => {
    setOpenValidationIssues(null);
    if (appliedProject) {
      clearOpenValidationPanel(appliedProject.id);
    }
  }, [appliedProject]);

  // Jump from a list row — delegates to the same focus-pulse pipeline
  // as the cycle button, so the highlight is tinted by `severity`
  // (sprint 29). The list stays open so the user can visit every
  // issue without reopening.
  const handleJumpFromIssuesList = useCallback(
    (path: string, severity: Issue['severity']): void => {
      handleFocusInEditor(path, severity);
    },
    [],
  );

  // Sprint 32 — validation-issue filter is now App-owned and
  // persistent. Lazy-init reads localStorage once at mount; setter
  // wraps both setState and the best-effort save so every change
  // round-trips. Sprint 31's per-node reset is gone: switching the
  // open node keeps the filter, so a "Errors only" preference
  // survives across the structure tree.
  const [validationIssueFilter, setValidationIssueFilter] =
    useState<ValidationIssueFilter>(() => loadValidationIssueFilter());

  const handleValidationIssueFilterChange = useCallback(
    (next: ValidationIssueFilter): void => {
      setValidationIssueFilter(next);
      saveValidationIssueFilter(next);
    },
    [],
  );

  // Sprint 31 / 33 / 34 — Alt+L opens / closes the validation
  // issues panel for the currently selected structure node. No-op
  // while the user is typing (any input / textarea / select /
  // contentEditable element, or anything inside a Monaco editor)
  // and no-op when no node is selected or the selected node has no
  // issues. Sprint 34 routes through
  // `handleOpenValidationIssuesAndFocus` so the panel ALSO moves
  // focus to its first visible row — only on the keyboard path,
  // not on mouse `⋯` clicks.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.altKey || event.key.toLowerCase() !== 'l') return;
      if (isTypingTarget(event.target)) return;
      if (!selectedNodeJsonPath) return;
      const items = validationIssuesForNode(
        selectedNodeJsonPath,
        structureValidationIssues,
      );
      if (items.length === 0) return;
      event.preventDefault();
      handleOpenValidationIssuesAndFocus(selectedNodeJsonPath);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    selectedNodeJsonPath,
    structureValidationIssues,
    handleOpenValidationIssuesAndFocus,
  ]);

  // Sprint 33 — Alt+1..Alt+4 cycle through validation filter chips
  // from anywhere on the page (not just inside the open panel).
  // Reuses the same `isTypingTarget` guard so typing in inputs /
  // textareas / Monaco never triggers a filter change.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return;
      if (!appliedProject) return;
      const filter = validationFilterForShortcut(event);
      if (filter === null) return;
      event.preventDefault();
      handleValidationIssueFilterChange(filter);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appliedProject, handleValidationIssueFilterChange]);

  // Sprint 35 — Validate is now a stable callback so both the
  // toolbar button AND the Ctrl/Cmd+Shift+V keyboard shortcut share
  // a single code path. A fresh report supersedes any cached
  // restore-banner — clear the note so the banner doesn't claim
  // "restored from local browser storage" while showing live data.
  const runValidation = useCallback((): void => {
    if (!appliedProject) return;
    const report = validate(appliedProject);
    setValidationReport(report);
    saveValidationReport(appliedProject.id, report);
    setValidationRestoreNote(null);
  }, [appliedProject]);

  // Sprint 35 — drop the cached validation report for the active
  // project. Closes the inline panel, clears its persisted marker,
  // and removes the restore banner. Idempotent / no-ops when no
  // project is loaded (the Discard button is only rendered with one).
  const handleDiscardValidationCache = useCallback((): void => {
    if (!appliedProject) return;
    const projectId = appliedProject.id;
    clearValidationReport(projectId);
    clearOpenValidationPanel(projectId);
    setValidationReport(null);
    setValidationRestoreNote(null);
    setOpenValidationIssues(null);
  }, [appliedProject]);

  // Sprint 35 — Ctrl+Shift+V (or Cmd+Shift+V on macOS) triggers
  // Validate from anywhere on the page. Same `isTypingTarget` guard
  // as Alt+L / Alt+1..4 so it never fires while the user is typing
  // in Monaco or any input. No-op without a loaded project — the
  // toolbar button is also disabled in that state.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isValidateShortcut(event)) return;
      if (isTypingTarget(event.target)) return;
      if (!appliedProject) return;
      event.preventDefault();
      runValidation();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appliedProject, runValidation]);

  // Sprint 33 / 34 — restore the open validation panel once per
  // loaded project. Gated by a ref that resets in the
  // `appliedProject` effect (so a fresh load gets one chance) and
  // by all prerequisites being ready: applied project, populated
  // structure tree, AND a usable validation source.
  //
  // Sprint 34 changes the validation-source gate to "report exists
  // OR draft is schema-valid". Previously we required at least one
  // issue, which meant a freshly-rehydrated zero-issue report kept
  // the saved panel marker alive forever (the gate never fired).
  // Now the gate fires the moment a report is loaded — even an
  // empty one — so a stale saved entry can be cleared.
  //
  // Storage is project-scoped: `loadOpenValidationPanel(id)` /
  // `clearOpenValidationPanel(id)`.
  useEffect(() => {
    if (hasRestoredOpenValidationPanelRef.current) return;
    if (!appliedProject) return;
    if (pirStructureFlat.length === 0) return;
    if (
      validationReport === null &&
      draftProjectState.kind !== 'valid'
    ) {
      return;
    }
    hasRestoredOpenValidationPanelRef.current = true;
    const saved = loadOpenValidationPanel(appliedProject.id);
    if (!saved) return;
    const node = findPirStructureNodeByPath(
      pirStructureFlat,
      saved.nodePath,
    );
    if (!node) {
      clearOpenValidationPanel(appliedProject.id);
      return;
    }
    const items = validationIssuesForNode(
      saved.nodePath,
      structureValidationIssues,
    );
    if (items.length === 0) {
      clearOpenValidationPanel(appliedProject.id);
      return;
    }
    setOpenValidationIssues({ nodePath: saved.nodePath });
    // Sprint 35 — also move keyboard focus to the panel's first
    // visible row, mirroring Alt+L semantics. A reload restoring
    // the panel should leave the user one Tab / arrow key away
    // from triaging issues, not staring at a static list.
    setValidationPanelFocusRequest({
      nodePath: saved.nodePath,
      nonce: ++validationPanelFocusNonceRef.current,
    });
  }, [
    appliedProject,
    pirStructureFlat,
    structureValidationIssues,
    validationReport,
    draftProjectState,
  ]);

  // The visual-edit entry point. Patches the draft JSON ONLY — never
  // touches `appliedProject`, `compileResult`, or `artifactsStale` until
  // the user explicitly hits Apply. On failure the inline error banner
  // surfaces the resolver's message so the user can retry.
  //
  // After a successful patch we eagerly recompute the draft state and
  // auto-promote the structure view to Draft when the new JSON is valid.
  // Computing inline (instead of waiting for the next render) avoids the
  // toggle flickering through an invalid intermediate state when the
  // patch produces a schema-failing draft.
  const patchDraftJson = useCallback(
    (path: string, value: string): void => {
      const result = setJsonPathValue(draftJson, path, value);
      if (!result.ok) {
        setVisualEditError(result.error);
        setVisualEditNote(null);
        return;
      }

      setDraftJson(result.jsonText);
      setVisualEditError(null);

      const nextState = getDraftProjectState(result.jsonText, appliedProject);
      if (nextState.kind === 'valid') {
        setStructureViewMode('draft');
        setStructureFallbackWarning(null);
        setVisualEditNote(
          'Updated draft JSON. Viewing draft structure. Apply JSON to promote.',
        );
      } else {
        // Draft saved but not viewable — keep the navigator on Applied
        // and tell the user why. The auto-fallback effect won't fire
        // because we never switched to Draft.
        setVisualEditNote(
          'Updated draft JSON. The draft is currently invalid; structure view stays on Applied. Fix and Apply when ready.',
        );
      }
    },
    [draftJson, appliedProject],
  );

  // The editor's onChange path. We clear the visual-edit note here so a
  // stale "updated from a visual field" banner doesn't linger while the
  // user is typing in Monaco directly.
  const handleDraftJsonChange = useCallback((next: string): void => {
    setDraftJson(next);
    setVisualEditNote(null);
  }, []);

  // Manual mode toggle from the navigator header. Always clears the
  // fallback warning — the user has explicitly acknowledged the state
  // by picking a mode.
  const handleStructureModeChange = useCallback(
    (next: StructureViewMode): void => {
      setStructureViewMode(next);
      setStructureFallbackWarning(null);
    },
    [],
  );

  // Tree-row click. Clears the "selected node does not exist…" note
  // since the user is now picking a node that does exist by construction.
  const handleStructureSelect = useCallback((jsonPath: string): void => {
    setSelectedNodeJsonPath(jsonPath);
    setStructureSelectionNote(null);
  }, []);

  // Sprint 34 — try to rehydrate the previously-saved validation
  // report for this project. Sets `validationReport` to the saved
  // value when found and surfaces `validationRestoreNote` so the
  // user knows the report came from cache (not a fresh
  // `validate(project)` call). Bails to `null` when no save exists,
  // so callers can use this as a single replace-all-validation
  // entry point on every project load.
  const tryRestoreValidationReport = useCallback((p: Project): void => {
    const saved = loadValidationReport(p.id);
    if (saved) {
      setValidationReport(saved.report);
      // Sprint 35 — derive the dominant tone from the cached report
      // so the banner is red/amber/blue instead of always-blue. The
      // age phrase ("5 min ago") is computed against the live wall
      // clock; a fresh `Date.now()` on every load is fine — the note
      // is rebuilt the moment the user reloads anyway.
      const counts = countValidationReportIssues(saved.report);
      const tone = validationReportTone(counts);
      const message = restoredValidationReportMessage(saved, Date.now());
      setValidationRestoreNote({ tone, message });
    } else {
      setValidationReport(null);
      setValidationRestoreNote(null);
    }
  }, []);

  // ---- Shared file-load handler used by FileUpload + DropZone ----
  const acceptProject = useCallback(
    (p: Project, name: string): void => {
      setAppliedProject(p);
      setFileName(name);
      setLoadError(null);
      setRestoreNote(null);
      setApplyNote(null);
      // Sprint 34 — restore the cached validation report (if any)
      // instead of unconditionally clearing it.
      tryRestoreValidationReport(p);
      setCompileResult(null);
      // A fresh project means no previous-generation reference applies — the
      // user is starting over.
      setPreviousCompileResult(null);
      setCompileError(null);
      setSelectedPath(null);
      setArtifactsStale(false);
      setSelectedNodeJsonPath(null);
      setPirFocusRequest(null);
      saveProject(name, p);
    },
    [tryRestoreValidationReport],
  );

  // ---- Apply a draft from the PIR editor ----
  // The schema is already valid (the PirEditor's apply button is disabled
  // otherwise). We:
  //   1. Promote the parsed Project to `appliedProject` (Generate / Validate
  //      now read this fresh).
  //   2. Run domain `validate()` to refresh the report.
  //   3. If artifacts already exist, mark them stale — the user must press
  //      Generate again to refresh them.
  //   4. Persist via `saveProject` so a tab reload restores the latest edit.
  const handleApply = useCallback(
    (next: Project, _rawJson: string): void => {
      setAppliedProject(next);
      // Run domain validation synchronously so the Applied-mode `⚠ N`
      // badges (sprint 28) light up immediately on the next render —
      // no separate Validate click required after Apply.
      const report = validate(next);
      setValidationReport(report);
      // Sprint 34 — persist the freshly-computed report so the next
      // tab reload can restore it without re-running validate().
      // Also clear the restore-banner note: a fresh report supersedes
      // any prior cached one.
      saveValidationReport(next.id, report);
      setValidationRestoreNote(null);
      setCompileError(null);
      const name = fileName ?? 'edited.json';
      saveProject(name, next);
      // Apply note now reports the validation outcome explicitly.
      // The "artifacts may be stale" message stays in its own yellow
      // banner (rendered separately from `applyNote`); the spec
      // requires the apply note not to mask it, so we don't append
      // stale text here.
      setApplyNote(applyNoteForReport(report));
      if (compileResult) setArtifactsStale(true);
    },
    [fileName, compileResult],
  );

  const handleProjectLoad = useCallback(
    (p: Project, name: string): void => {
      acceptProject(p, name);
      setDropInfo(null);
    },
    [acceptProject],
  );

  // Drop handler: re-uses readProjectFromFile so the validation pipeline is
  // identical to the Upload-button path.
  const handleDropFile = useCallback(
    async (file: File, opts: { multiple: boolean }): Promise<void> => {
      const result = await readProjectFromFile(file);
      if (result.ok) {
        acceptProject(result.project, file.name);
        setDropInfo(
          opts.multiple
            ? `Multiple files dropped — using "${file.name}" only.`
            : null,
        );
      } else {
        setLoadError(result.error);
        setDropInfo(null);
      }
    },
    [acceptProject],
  );

  function handleClearSaved(): void {
    clearSavedProject();
    setRestoreNote('Saved project cleared from local browser storage.');
  }

  // Generation runs in a Web Worker (see `worker/compile-worker.ts`). The
  // main thread stays responsive — drag overlay, button feedback, and tab
  // navigation all keep working while a large PIR compiles. If the Worker
  // constructor failed at app boot (CSP, sandbox, …) the client falls back
  // to a main-thread compile transparently; the only visible difference is
  // a one-line "Web Worker unavailable" note.
  //
  // Concurrency: the Generate button is disabled while `isGenerating === true`,
  // so two-in-flight requests aren't reachable from the UI. The client tracks
  // requests by id so even if a second request started, only its response
  // could resolve (no stale state from older requests).
  async function handleGenerate(): Promise<void> {
    const client = clientRef.current;
    if (!appliedProject || isGenerating || !client) return;
    setIsGenerating(true);
    try {
      const result = await client.compile(appliedProject, backend);
      // Rotate: the result we're about to overwrite becomes the "previous"
      // reference for the artifact-diff toggle. Failure path (the catch
      // block below) intentionally does not touch either slot.
      setPreviousCompileResult(compileResult);
      setCompileResult(result);
      setCompileError(null);
      setCompileErrorDetails(null);
      setArtifactsStale(false);
      setApplyNote(null);
      setSelectedPath(selectBestArtifact(selectedPath, result.artifacts));
    } catch (e) {
      // Sprint 43 — keep both shapes in sync:
      //   `compileError`        formatted single-line for the banner text
      //   `compileErrorDetails` structured shape for the Jump-to-PIR
      //                         action and any future details surface.
      const serialized =
        e instanceof CompileClientError
          ? e.serialized
          : serializeCompilerError(e);
      setCompileError(
        e instanceof CompileClientError
          ? e.message
          : formatSerializedCompilerError(serialized),
      );
      setCompileErrorDetails(serialized);
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleDownloadZip(): Promise<void> {
    if (!compileResult) return;
    try {
      // Sprint 51 — summary.json shape lives in `utils/web-summary.ts`
      // and is now formally validated by the CLI's
      // `web-zip-summary.schema.json` static schema. Behaviour-
      // preserving: the field set is identical to the previous
      // inline literal, just centralised so the contract has a
      // single source of truth.
      const webSummary = buildWebZipSummary({
        backend: compileResult.backend,
        artifactCount: compileResult.summary.artifactCount,
        diagnostics: {
          errors: compileResult.summary.errors,
          warnings: compileResult.summary.warnings,
          info: compileResult.summary.info,
        },
      });
      await downloadArtifactsZip(compileResult.artifacts, undefined, {
        // `BuildArtifactsZipOptions.summary` is typed as a generic
        // `Record<string, unknown>` since the writer just
        // JSON.stringifies whatever it receives. The structured
        // `WebZipSummary` shape is locked separately by
        // `web-zip-summary.schema.json` (sprint 51).
        summary: webSummary as unknown as Record<string, unknown>,
      });
    } catch (e) {
      // Sprint 43 — same dual-state pattern as handleGenerate so the
      // download path can surface a Jump-to-PIR if a future Blob/zip
      // failure ever produces a structured `path`.
      const serialized =
        e instanceof CompileClientError
          ? e.serialized
          : serializeCompilerError(e);
      setCompileError(
        e instanceof CompileClientError
          ? e.message
          : formatSerializedCompilerError(serialized),
      );
      setCompileErrorDetails(serialized);
    }
  }

  return (
    <div className="app">
      <DropZone onFile={handleDropFile} onError={setLoadError} />

      <header className="app-header">
        <h1>PlcCopilot — Web MVP</h1>
        <p className="muted">
          Local PIR ↔ artifacts inspector. Everything runs in your browser; no
          server, no upload. Drag a <code>.json</code> file anywhere on the
          page to load it.
        </p>
      </header>

      <Toolbar>
        <FileUpload onLoad={handleProjectLoad} onError={setLoadError} />
        <BackendSelector value={backend} onChange={setBackend} />
        <button
          type="button"
          className="btn"
          onClick={runValidation}
          disabled={!appliedProject || isGenerating}
          title="Validate the applied PIR (Ctrl+Shift+V)"
        >
          Validate
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={handleGenerate}
          disabled={!appliedProject || isGenerating}
        >
          {isGenerating ? 'Generating…' : 'Generate'}
        </button>
        {compileResult ? (
          <>
            <button
              type="button"
              className="btn primary"
              onClick={handleDownloadZip}
              disabled={isGenerating}
            >
              Download ZIP
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => downloadArtifactBundle(compileResult.artifacts)}
              disabled={isGenerating}
            >
              Download bundle (.json)
            </button>
          </>
        ) : null}
        {appliedProject ? (
          <button
            type="button"
            className="btn"
            onClick={handleClearSaved}
            disabled={isGenerating}
            title="Remove the saved PIR from this browser's local storage"
          >
            Clear saved project
          </button>
        ) : null}
      </Toolbar>

      {workerNote ? (
        <div className="banner banner-info">{workerNote}</div>
      ) : null}
      {restoreNote ? (
        <div className="banner banner-info">{restoreNote}</div>
      ) : null}
      {validationRestoreNote ? (
        <div className={`banner banner-${validationRestoreNote.tone}`}>
          <span>{validationRestoreNote.message}</span>
          {appliedProject ? (
            <button
              type="button"
              className="banner-action"
              onClick={handleDiscardValidationCache}
              title="Discard the cached validation report for this project"
            >
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
      {dropInfo ? (
        <div className="banner banner-info">{dropInfo}</div>
      ) : null}
      {applyNote ? (
        <div className="banner banner-info">{applyNote}</div>
      ) : null}
      {visualEditNote ? (
        <div className="banner banner-info">{visualEditNote}</div>
      ) : null}
      {visualEditError ? (
        <div className="banner banner-error">
          <strong>Visual edit failed:</strong> {visualEditError}
        </div>
      ) : null}
      {artifactsStale && compileResult ? (
        <div className="banner banner-warning">
          <strong>Artifacts may be stale:</strong> the project was changed
          since the last generation. Click <em>Generate</em> to refresh.
        </div>
      ) : null}
      {loadError ? (
        <div className="banner banner-error">
          <strong>Could not load PIR:</strong>
          <pre>{loadError}</pre>
        </div>
      ) : null}
      {compileError ? (
        <div className="banner banner-error compile-error">
          <strong>Generation failed:</strong>{' '}
          {(() => {
            // Sprint 39 — `compileError` is the formatted output of
            // `formatSerializedCompilerError` (e.g. `[UNKNOWN_PARAMETER]
            // Recipe "..." references unknown parameter "p_x"
            // (path: ...) Hint: ...`). Render the leading `[CODE]`
            // chip separately so the user can scan it; the rest stays
            // pre-wrapped so multi-line stacks (debug mode) wrap
            // gracefully.
            const split = splitErrorCodePrefix(compileError);
            // Sprint 43 — show "Jump to PIR" only when we have a
            // navigable JSON path AND a project loaded. The action
            // reuses the existing focus pipeline (handleFocusInEditor)
            // with severity `error` so Monaco highlights the value
            // range in red. `isPirJsonPath` rejects FB-name
            // placeholders so the button doesn't dangle on
            // unsupported paths.
            const detailPath = compileErrorDetails?.path;
            const canJump = appliedProject !== null && isPirJsonPath(detailPath);
            return (
              <>
                {split.code ? (
                  <code className="banner-code">{split.code}</code>
                ) : null}
                <pre className="banner-message">{split.rest}</pre>
                {canJump ? (
                  <button
                    type="button"
                    className="banner-action"
                    onClick={() => handleFocusInEditor(detailPath!, 'error')}
                    title={`Scroll the PIR editor to ${detailPath}`}
                  >
                    Jump to PIR
                  </button>
                ) : null}
              </>
            );
          })()}
        </div>
      ) : null}

      {appliedProject ? (
        <>
          <ProjectSummary project={appliedProject} fileName={fileName} />
          {pirStructureTree ? (
            <section className="card pir-structure">
              <header className="panel-header">
                <h2>PIR Structure</h2>
                <StructureViewModeToggle
                  mode={structureViewMode}
                  draftAvailable={draftProjectState.kind === 'valid'}
                  onModeChange={handleStructureModeChange}
                  draftIssue={draftViewIssue(draftProjectState)}
                />
              </header>
              {structureFallbackWarning ? (
                <div className="banner banner-warning">
                  {structureFallbackWarning}
                </div>
              ) : null}
              {structureSelectionNote ? (
                <div className="banner banner-info">
                  {structureSelectionNote}
                </div>
              ) : null}
              <div className="structure-layout">
                <PirStructureTree
                  root={pirStructureTree}
                  selectedJsonPath={selectedNodeJsonPath}
                  onSelect={handleStructureSelect}
                  changedPaths={changedStructurePaths}
                  changeCounts={structureChangeCounts}
                  changeBreakdowns={structureChangeBreakdowns}
                  diffs={pirDiffs}
                  onFocusInEditor={handleFocusInEditor}
                  onFocusNextChange={handleFocusNextStructureChange}
                  validationCounts={validationCounts}
                  validationBreakdowns={validationBreakdowns}
                  validationIssues={structureValidationIssues}
                  onFocusNextValidationIssue={handleFocusNextValidationIssue}
                  onOpenValidationIssues={handleOpenValidationIssues}
                  openValidationNodePath={openValidationIssues?.nodePath ?? null}
                />
                <PirStructureDetails
                  project={viewProject}
                  node={selectedStructureNode}
                  onFocusInEditor={handleFocusInEditor}
                  onPatch={patchDraftJson}
                  diffs={pirDiffs}
                />
              </div>
              {/*
                Sprint 30 / 31 — inline validation-issues panel. Lives
                below the navigator grid, spans full card width. The
                triple-condition gate matches the auto-close effect
                so a stale open-state can't render an empty panel: we
                require an open node, that node still in the live
                tree, and at least one issue under it.
              */}
              {openValidationIssues &&
              openValidationIssueNode &&
              openValidationIssueItems.length > 0 ? (
                <ValidationIssuesList
                  nodeLabel={openValidationIssueNode.label}
                  nodePath={openValidationIssues.nodePath}
                  issues={openValidationIssueItems}
                  filter={validationIssueFilter}
                  onFilterChange={handleValidationIssueFilterChange}
                  onJump={handleJumpFromIssuesList}
                  onClose={handleCloseValidationIssues}
                  focusRequest={
                    validationPanelFocusRequest &&
                    validationPanelFocusRequest.nodePath ===
                      openValidationIssues.nodePath
                      ? { nonce: validationPanelFocusRequest.nonce }
                      : null
                  }
                />
              ) : null}
            </section>
          ) : null}
          <PirEditor
            project={appliedProject}
            fileName={fileName}
            validationReport={validationReport}
            onApply={handleApply}
            draftJson={draftJson}
            onDraftJsonChange={handleDraftJsonChange}
            focusRequest={pirFocusRequest}
          />
        </>
      ) : (
        <section className="card">
          <p className="muted">
            Upload a PIR JSON file (or drop one anywhere on the page) to begin.
            The canonical fixture lives at{' '}
            <code>packages/pir/src/fixtures/weldline.json</code>.
          </p>
        </section>
      )}

      {validationReport ? (
        <DiagnosticsPanel
          title={`Validation ${validationReport.ok ? '✓' : '✗'}`}
          diagnostics={validationDiagnostics}
        />
      ) : null}

      {compileResult ? (
        <>
          <DiagnosticsPanel
            title={`Compiler diagnostics — ${compileResult.backend}`}
            diagnostics={compilerDiagnosticsForPanel}
            onJumpToPath={handleJumpFromDiagnosticRow}
            isJumpablePath={isPirJsonPath}
          />

          <section className="card artifacts">
            <header className="panel-header">
              <h2>Artifacts</h2>
              <span className="muted">
                {compileResult.summary.artifactCount} files ·{' '}
                {compileResult.summary.errors} errors ·{' '}
                {compileResult.summary.warnings} warnings ·{' '}
                {compileResult.summary.info} info
              </span>
            </header>
            <div className="artifact-layout">
              <ArtifactTree
                artifacts={compileResult.artifacts}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
              />
              <ArtifactPreview
                artifact={selectedArtifact}
                previousArtifact={previousArtifact}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

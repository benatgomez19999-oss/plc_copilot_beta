// Sprint 76 — PIR builder v0. The deterministic bridge between a
// human-reviewed PirDraftCandidate and a valid `@plccopilot/pir`
// `Project`.
//
// Architectural invariants this module enforces:
//
//   1. The gate `isReviewedCandidateReadyForPirBuild` MUST pass
//      before any PIR is produced. If it does not, the builder
//      returns diagnostics + `pir: undefined` — never a partial
//      project.
//
//   2. Only `'accepted'` items contribute. `'pending'` blocks
//      (gate failure). `'rejected'` items are silently excluded
//      and counted in `skippedInputCounts.rejected`.
//
//   3. Assumptions never become hard PIR facts. An accepted
//      assumption is recorded in `sourceMap` + counted under
//      `unsupportedAssumptions` and surfaces an info diagnostic.
//
//   4. IDs must be canonicalised — PIR's `IdSchema` is
//      `/^[a-z][a-z0-9_]{1,62}$/`. Candidate ids like `device:B1`
//      / `plc_channel:%I0.0` get rewritten deterministically.
//
//   5. Source refs ARE preserved. PIR's `Provenance` doesn't carry
//      sourceRefs, so the builder also returns a `sourceMap`
//      sidecar keyed by the rewritten PIR id. Sprint 76 emits a
//      one-time info diagnostic announcing the sidecar so callers
//      know to consume it.
//
//   6. Sprint 76 v0 emits a placeholder `sequence` (init → terminal)
//      because PIR's `SequenceSchema` requires `states.min(2) +
//      transitions.min(1)`. Sprint 77+ may take sequences from a
//      reviewed source. The placeholder is announced via an info
//      diagnostic.

import { validate as validatePirProject } from '@plccopilot/pir';
import type {
  Equipment,
  EquipmentType,
  IoAddress,
  IoSignal,
  MemoryArea,
  Project,
  Provenance,
  Sequence,
  SignalDirection,
  Station,
} from '@plccopilot/pir';

import { detectPlcAddress } from '../normalize.js';
import type {
  PirDraftCandidate,
  PirEquipmentCandidate,
  PirIoCandidate,
  PirMappingAssumption,
  SourceRef,
} from '../types.js';
import {
  diagnoseHardenedGraph,
  summarizeAcceptedGraph,
} from './electrical-graph-hardening.js';
import {
  getReviewedDecision,
  type PirBuildReviewState,
} from './review-types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PirBuildOptions {
  /** Project id to use. Default `prj_review`. Must match `IdSchema`. */
  projectId?: string;
  projectName?: string;
  /** Machine id. Default `mch_review`. */
  machineId?: string;
  machineName?: string;
  /** Single-station id. Default `st_review`. */
  stationId?: string;
  stationName?: string;
  /**
   * If true, also fail when warnings exist in the candidate or in
   * the mapping. Default false.
   */
  strict?: boolean;
  /**
   * Provenance source label for generated PIR objects. Default
   * `'import'` — the data came from a structured import that a
   * human signed off.
   */
  provenanceSource?: Provenance['source'];
  /**
   * ISO timestamp string for `provenance.created_at`. Defaults to
   * `'1970-01-01T00:00:00.000Z'` so test fixtures stay deterministic;
   * production callers should pass `new Date().toISOString()`.
   */
  provenanceCreatedAt?: string;
}

export type PirBuildDiagnosticCode =
  | 'PIR_BUILD_REVIEW_NOT_READY'
  | 'PIR_BUILD_PENDING_REVIEW_ITEM'
  | 'PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT'
  | 'PIR_BUILD_MISSING_REVIEW_DECISION'
  | 'PIR_BUILD_ACCEPTED_IO_MISSING_ADDRESS'
  | 'PIR_BUILD_ACCEPTED_IO_MISSING_DIRECTION'
  | 'PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS'
  | 'PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND'
  | 'PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID'
  | 'PIR_BUILD_UNSUPPORTED_ASSUMPTION'
  | 'PIR_BUILD_SCHEMA_VALIDATION_FAILED'
  | 'PIR_BUILD_SOURCE_REFS_SIDECAR_USED'
  | 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED'
  | 'PIR_BUILD_EMPTY_ACCEPTED_INPUT'
  // ---- Sprint 85: electrical graph / PIR hardening ----
  // Root-cause diagnostics emitted from the new hardening pass
  // BEFORE the per-item build loops, so operators see the
  // underlying reason for an empty/refused PIR instead of just
  // the post-hoc cascade. See `electrical-graph-hardening.ts`.
  | 'PIR_BUILD_EQUIPMENT_REFERENCES_UNBUILDABLE_IO'
  | 'PIR_BUILD_EQUIPMENT_REFERENCES_UNACCEPTED_IO'
  | 'PIR_BUILD_EQUIPMENT_REFERENCES_MISSING_IO'
  | 'PIR_BUILD_ACCEPTED_IO_ORPHANED'
  | 'PIR_BUILD_ACCEPTED_EQUIPMENT_ORPHANED'
  | 'PIR_BUILD_DUPLICATE_IO_ADDRESS'
  | 'PIR_BUILD_DUPLICATE_IO_TAG'
  | 'PIR_BUILD_NO_BUILDABLE_IO_AFTER_HARDENING';

export interface PirBuildDiagnostic {
  code: PirBuildDiagnosticCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Candidate id (un-canonicalised) when relevant. */
  candidateId?: string;
  /** PIR-side path when validator returned one. */
  path?: string;
  /** Source refs of the offending candidate. */
  sourceRefs?: SourceRef[];
}

export interface PirBuildResult {
  /** The built PIR project. `undefined` when the build was refused. */
  pir?: Project;
  diagnostics: PirBuildDiagnostic[];
  /**
   * Sprint 76 sidecar: candidate-side source-trace propagation that
   * does not fit in PIR's stricter schema. Keyed by the PIR-side id
   * (e.g. `io_b1`, `eq_y1`).
   */
  sourceMap: Record<string, SourceRef[]>;
  acceptedInputCounts: {
    io: number;
    equipment: number;
    assumptions: number;
  };
  skippedInputCounts: {
    pending: number;
    rejected: number;
    unsupportedAssumptions: number;
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * True if the candidate has at least one reviewable item across
 * IO + equipment + assumptions. Sprint 78A added this so a
 * candidate with literally nothing to review (e.g. an XML format
 * the ingestor doesn't yet recognise) can no longer report itself
 * as "ready" — the UX bug observed during Sprint 77 manual
 * testing.
 */
export function hasReviewableCandidates(candidate: PirDraftCandidate): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const io = candidate.io ?? [];
  const eq = candidate.equipment ?? [];
  const as = candidate.assumptions ?? [];
  return io.length > 0 || eq.length > 0 || as.length > 0;
}

/**
 * Domain-layer counterpart of the web helper. Returns `false` if:
 *
 *   - any IO / equipment / assumption is still pending, OR
 *   - the candidate carries any error-severity diagnostic, OR
 *   - the candidate has zero reviewable items (Sprint 78A — empty
 *     candidates must not report themselves as ready).
 *
 * The web `isReadyForPirBuilder` and this function MUST agree on
 * semantics — the builder uses this one as the authoritative gate
 * (the web helper is the UX surface that explains the same answer
 * to the operator).
 */
export function isReviewedCandidateReadyForPirBuild(
  candidate: PirDraftCandidate,
  state: PirBuildReviewState,
): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!state || typeof state !== 'object') return false;
  // Sprint 78A — empty candidate is not ready. The builder still
  // emits PIR_BUILD_EMPTY_ACCEPTED_INPUT defensively, but the gate
  // now reports the situation up-front so the UI can disable the
  // Build button without round-tripping through the builder.
  if (!hasReviewableCandidates(candidate)) return false;
  for (const io of candidate.io ?? []) {
    if (getReviewedDecision(state, 'io', io.id) === 'pending') return false;
  }
  for (const eq of candidate.equipment ?? []) {
    if (getReviewedDecision(state, 'equipment', eq.id) === 'pending') {
      return false;
    }
  }
  for (const as of candidate.assumptions ?? []) {
    if (getReviewedDecision(state, 'assumption', as.id) === 'pending') {
      return false;
    }
  }
  for (const d of candidate.diagnostics ?? []) {
    if (d.severity === 'error') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers — ID canonicalisation, address parsing, kind mapping
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * Canonicalise a free-form candidate id into a PIR-safe id.
 *
 *   `device:B1`              → `b1` (or `<prefix>_b1` when caller passes a prefix)
 *   `plc_channel:%I0.0`      → `io_i0_0`
 *   `io_plc_channel:%Q1.7`   → `io_q1_7`
 *   `eq_device:Y1`           → `eq_y1`
 *
 * The function:
 *   - lowercases everything
 *   - replaces every non-`[a-z0-9_]` character with `_`
 *   - collapses runs of `_`
 *   - prefixes a leading `x` when the result starts with a digit
 *   - truncates to PIR's 63-char ceiling
 *   - prepends an optional caller prefix (e.g. `'io'`, `'eq'`)
 */
export function canonicalisePirId(raw: string, prefix?: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('canonicalisePirId: raw id must be a non-empty string.');
  }
  const lowered = raw.toLowerCase();
  // Strip any well-known candidate-side scheme prefix (`device:`,
  // `io_plc_channel:`, etc.) to keep the canonical form short.
  const stripped = lowered
    .replace(/^io_plc_channel:/, '')
    .replace(/^plc_channel:/, '')
    .replace(/^device:/, '')
    .replace(/^eq_device:/, '')
    .replace(/^assum_/, '')
    .replace(/^io_/, '');
  let cleaned = stripped.replace(/[^a-z0-9_]+/g, '_');
  cleaned = cleaned.replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (cleaned.length === 0) cleaned = 'x';
  if (/^[0-9]/.test(cleaned)) cleaned = `x${cleaned}`;
  let result = prefix ? `${prefix}_${cleaned}` : cleaned;
  // Same shape adjustments after prefixing.
  if (/^[0-9]/.test(result)) result = `x${result}`;
  if (result.length > 63) result = result.slice(0, 63);
  result = result.replace(/_$/, '');
  if (!ID_RE.test(result)) {
    // Last-ditch: substitute every offending leading char.
    result = `x${result.replace(/^[^a-z]+/, '')}`.slice(0, 63);
  }
  return result;
}

/**
 * Parse a candidate-style PLC address string into PIR's `IoAddress`
 * structure. Returns null if the address can't be mapped (unknown
 * memory area, etc.).
 *
 * Sprint 76 supports the subset that maps to PIR's `MemoryArea`
 * union (`I` / `Q` / `M` / `DB`):
 *   - `%I0.0`, `%Q1.7`           → bool bit-addressed
 *   - `%IB0`, `%QB1`             → byte (treated as bool unless
 *                                  caller overrides; PIR has no
 *                                  byte-only data type)
 *   - `%IW10`, `%QW20`           → int word
 *   - `%MD100`, `%QD200`         → real double-word (best effort)
 *
 * Codesys `%IX0.0` collapses to `%I0.0`. Rockwell `Local:1:I.Data[0].0`
 * is detected by `detectPlcAddress` but its exact byte/bit can't be
 * mapped 1:1 to PIR's Siemens-style memory area — Sprint 76 treats
 * `Local:N:I.Data[B].b` as `{memory_area: 'I', byte: B, bit: b}`,
 * losing the slot index `N`. The slot is preserved in
 * `IoSignal.description` instead.
 */
export interface ParsedIoAddress {
  address: IoAddress;
  data_type: IoSignal['data_type'];
  /** Suffix to embed into a `description` for context-loss cases. */
  descriptionHint?: string;
}

export function parseCandidateAddress(raw: string): ParsedIoAddress | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const detected = detectPlcAddress(raw);
  if (!detected) return null;

  // Siemens / generic `%I0.0` / `I0.0` / `%IB1` / `%IW10` / `%QD200`.
  const sm = /^%?([IQMA])([XBWD]?)(\d+)(?:\.(\d+))?$/i.exec(detected.raw.trim());
  if (sm) {
    const areaChar = sm[1].toUpperCase();
    if (!['I', 'Q', 'M', 'DB'].includes(areaChar) && areaChar !== 'A') {
      return null;
    }
    const memory_area: MemoryArea | null =
      areaChar === 'I' || areaChar === 'Q' || areaChar === 'M'
        ? (areaChar as MemoryArea)
        : null;
    if (!memory_area) return null;
    const sizeChar = (sm[2] || '').toUpperCase();
    const byte = Number(sm[3]);
    const bitPart = sm[4];
    if (!Number.isFinite(byte) || byte < 0) return null;

    if (sizeChar === 'X' || (sizeChar === '' && bitPart !== undefined)) {
      const bit = Number(bitPart ?? 0);
      if (!Number.isFinite(bit) || bit < 0 || bit > 7) return null;
      return {
        address: { memory_area, byte, bit },
        data_type: 'bool',
      };
    }
    if (sizeChar === 'B' && bitPart === undefined) {
      // Byte-wide; PIR has no byte type, fall back to int.
      return {
        address: { memory_area, byte },
        data_type: 'int',
      };
    }
    if (sizeChar === 'W' && bitPart === undefined) {
      return {
        address: { memory_area, byte },
        data_type: 'int',
      };
    }
    if (sizeChar === 'D' && bitPart === undefined) {
      return {
        address: { memory_area, byte },
        data_type: 'real',
      };
    }
    if (sizeChar === '' && bitPart === undefined) {
      // Bare `%I0` — treat as bit 0.
      return {
        address: { memory_area, byte, bit: 0 },
        data_type: 'bool',
      };
    }
    return null;
  }

  // Rockwell — Local:1:I.Data[0].0
  const rm = /^Local:(\d+):([IO])\.Data\[(\d+)\]\.(\d+)$/i.exec(detected.raw);
  if (rm) {
    const slot = rm[1];
    const dir = rm[2].toUpperCase();
    const byte = Number(rm[3]);
    const bit = Number(rm[4]);
    if (!Number.isFinite(byte) || byte < 0) return null;
    if (!Number.isFinite(bit) || bit < 0 || bit > 7) return null;
    const memory_area: MemoryArea = dir === 'I' ? 'I' : 'Q';
    return {
      address: { memory_area, byte, bit },
      data_type: 'bool',
      descriptionHint: `Rockwell Local:${slot}:${dir}.Data[${byte}].${bit} (slot ${slot} preserved in description; PIR memory_area collapses to ${memory_area})`,
    };
  }
  return null;
}

/**
 * Map candidate direction strings to PIR's `SignalDirection`.
 */
export function mapCandidateDirection(
  direction: PirIoCandidate['direction'],
): SignalDirection | null {
  if (direction === 'input') return 'in';
  if (direction === 'output') return 'out';
  return null;
}

/**
 * Map candidate equipment kinds to PIR's `EquipmentType`. Returns
 * null when the candidate kind has no safe equivalent — caller
 * emits `PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND` in that case.
 */
export function mapCandidateEquipmentKind(
  kind: PirEquipmentCandidate['kind'],
): EquipmentType | null {
  switch (kind) {
    case 'sensor_discrete':
      return 'sensor_discrete';
    case 'motor_simple':
      return 'motor_simple';
    case 'pneumatic_cylinder_2pos':
      return 'pneumatic_cylinder_2pos';
    case 'valve_solenoid':
      return 'valve_onoff';
    case 'unknown':
    default:
      return null;
  }
}

/**
 * Per-PIR-EquipmentType role remap. The Sprint 72 candidate mapper
 * uses generic role names (`drive`, `drive_1`, `feedback`,
 * `feedback_1`, `io_0`, ...). PIR's equipment shapes have specific
 * required role names per type (e.g. `signal_in` for
 * `sensor_discrete`, `run_out` for `motor_simple`). The table below
 * remaps the generic candidate names into the PIR-canonical names
 * that satisfy `R-EQ-01` / `R-EQ-02`.
 *
 * The order in `output` / `input` matters — the first IO bound to
 * `drive`/`drive_1`/... lands on the first slot of `output`, etc.
 *
 * Roles not in this table (or extras beyond the slots a shape
 * supports) get dropped with `PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID`
 * so the builder fails loudly instead of silently truncating.
 */
const EQUIPMENT_ROLE_REMAP: Record<
  EquipmentType,
  { output: string[]; input: string[] }
> = {
  sensor_discrete: { output: [], input: ['signal_in'] },
  sensor_analog: { output: [], input: ['signal_in'] },
  motor_simple: { output: ['run_out'], input: ['running_fb', 'fault_fb'] },
  motor_vfd_simple: {
    output: ['run_out', 'speed_setpoint_out'],
    input: ['running_fb', 'fault_fb', 'speed_fb'],
  },
  valve_onoff: { output: ['solenoid_out'], input: ['open_fb', 'closed_fb'] },
  pneumatic_cylinder_2pos: {
    output: ['solenoid_out'],
    input: ['sensor_extended', 'sensor_retracted'],
  },
  pneumatic_cylinder_1pos: {
    output: ['solenoid_out'],
    input: ['sensor_extended'],
  },
  indicator_light: { output: ['light_out'], input: [] },
  supervisor: { output: [], input: [] },
};

/**
 * Remap candidate ioBindings (`drive`, `drive_1`, `feedback`,
 * `feedback_1`, ...) to the PIR-canonical role names for the
 * given equipment type. Returns `{ remapped, extras }`; the
 * caller surfaces extras as a diagnostic + refuses the build.
 */
export function remapEquipmentRoles(
  type: EquipmentType,
  candidateBindings: Record<string, string>,
): { remapped: Record<string, string>; extras: string[] } {
  const slots = EQUIPMENT_ROLE_REMAP[type] ?? { output: [], input: [] };
  const driveEntries: Array<{ role: string; ioId: string }> = [];
  const feedbackEntries: Array<{ role: string; ioId: string }> = [];
  const passThrough: Record<string, string> = {};
  for (const [role, ioId] of Object.entries(candidateBindings ?? {})) {
    if (typeof ioId !== 'string') continue;
    if (/^drive(_\d+)?$/.test(role)) {
      driveEntries.push({ role, ioId });
    } else if (/^feedback(_\d+)?$/.test(role)) {
      feedbackEntries.push({ role, ioId });
    } else if (/^io_\d+$/.test(role)) {
      // generic — try to map to next available output slot first,
      // then input.
      driveEntries.push({ role, ioId });
    } else {
      // Caller used a role name that already matches a PIR slot
      // (e.g. operator hand-edited candidate). Pass through.
      passThrough[role] = ioId;
    }
  }
  // Sort drive_/feedback_ by their numeric suffix so the order is
  // deterministic (`drive`, `drive_1`, `drive_2`, ...).
  driveEntries.sort((a, b) => suffixIndex(a.role) - suffixIndex(b.role));
  feedbackEntries.sort((a, b) => suffixIndex(a.role) - suffixIndex(b.role));

  const remapped: Record<string, string> = { ...passThrough };
  const extras: string[] = [];
  for (let i = 0; i < driveEntries.length; i++) {
    if (i < slots.output.length) {
      remapped[slots.output[i]] = driveEntries[i].ioId;
    } else {
      extras.push(driveEntries[i].role);
    }
  }
  for (let i = 0; i < feedbackEntries.length; i++) {
    if (i < slots.input.length) {
      remapped[slots.input[i]] = feedbackEntries[i].ioId;
    } else {
      extras.push(feedbackEntries[i].role);
    }
  }
  return { remapped, extras };
}

function suffixIndex(role: string): number {
  const m = /_(\d+)$/.exec(role);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const PLACEHOLDER_SEQUENCE: Sequence = Object.freeze({
  states: [
    { id: 's_init', name: 'Init', kind: 'initial' as const },
    { id: 's_terminal', name: 'Terminal', kind: 'terminal' as const },
  ],
  transitions: [
    {
      id: 't_init_to_terminal',
      from: 's_init',
      to: 's_terminal',
      priority: 1,
    },
  ],
}) as Sequence;

interface BuildContext {
  options: Required<
    Pick<
      PirBuildOptions,
      'projectId' | 'projectName' | 'machineId' | 'machineName' | 'stationId' | 'stationName' | 'provenanceSource' | 'provenanceCreatedAt'
    >
  >;
  diagnostics: PirBuildDiagnostic[];
  sourceMap: Record<string, SourceRef[]>;
  candidateIoIdToPirId: Map<string, string>;
  acceptedIo: number;
  acceptedEquipment: number;
  acceptedAssumptions: number;
  skippedRejected: number;
  skippedPending: number;
  unsupportedAssumptions: number;
}

function pushDiag(
  ctx: BuildContext,
  d: PirBuildDiagnostic,
): void {
  ctx.diagnostics.push(d);
}

function provenance(ctx: BuildContext, notes?: string): Provenance {
  const p: Provenance = {
    source: ctx.options.provenanceSource,
    created_at: ctx.options.provenanceCreatedAt,
  };
  if (notes) p.notes = notes;
  return p;
}

export function buildPirFromReviewedCandidate(
  candidate: PirDraftCandidate,
  state: PirBuildReviewState,
  options: PirBuildOptions = {},
): PirBuildResult {
  const ctx: BuildContext = {
    options: {
      projectId: options.projectId ?? 'prj_review',
      projectName: options.projectName ?? 'Reviewed candidate',
      machineId: options.machineId ?? 'mch_review',
      machineName: options.machineName ?? 'Reviewed machine',
      stationId: options.stationId ?? 'st_review',
      stationName: options.stationName ?? 'Reviewed station',
      provenanceSource: options.provenanceSource ?? 'import',
      provenanceCreatedAt:
        options.provenanceCreatedAt ?? '1970-01-01T00:00:00.000Z',
    },
    diagnostics: [],
    sourceMap: {},
    candidateIoIdToPirId: new Map(),
    acceptedIo: 0,
    acceptedEquipment: 0,
    acceptedAssumptions: 0,
    skippedRejected: 0,
    skippedPending: 0,
    unsupportedAssumptions: 0,
  };

  // -------------------------------------------------------------
  // Gate
  // -------------------------------------------------------------
  if (!candidate || typeof candidate !== 'object') {
    pushDiag(ctx, {
      code: 'PIR_BUILD_REVIEW_NOT_READY',
      severity: 'error',
      message: 'candidate is not an object — refusing to build PIR.',
    });
    return finaliseRefused(ctx);
  }
  if (!state || typeof state !== 'object') {
    pushDiag(ctx, {
      code: 'PIR_BUILD_REVIEW_NOT_READY',
      severity: 'error',
      message: 'review state is not an object — refusing to build PIR.',
    });
    return finaliseRefused(ctx);
  }

  // Sprint 78A — empty-candidate up-front check. Without this the
  // builder would walk through to the post-mapping empty check; we
  // emit the same `PIR_BUILD_EMPTY_ACCEPTED_INPUT` diagnostic with
  // a clearer message ("nothing to review") so the UX surface
  // shows the operator why the build refused.
  if (!hasReviewableCandidates(candidate)) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_EMPTY_ACCEPTED_INPUT',
      severity: 'error',
      message:
        'candidate has no reviewable items — the ingestor extracted no IO, equipment, or assumptions from this source.',
    });
    return finaliseRefused(ctx);
  }

  // Tally pending items as diagnostics.
  let blockedByPending = false;
  for (const io of candidate.io ?? []) {
    const d = getReviewedDecision(state, 'io', io.id);
    if (d === 'pending') {
      pushDiag(ctx, {
        code: 'PIR_BUILD_PENDING_REVIEW_ITEM',
        severity: 'error',
        message: `IO candidate ${io.id} is still pending review — accept or reject before building.`,
        candidateId: io.id,
        sourceRefs: io.sourceRefs,
      });
      blockedByPending = true;
    }
  }
  for (const eq of candidate.equipment ?? []) {
    const d = getReviewedDecision(state, 'equipment', eq.id);
    if (d === 'pending') {
      pushDiag(ctx, {
        code: 'PIR_BUILD_PENDING_REVIEW_ITEM',
        severity: 'error',
        message: `Equipment candidate ${eq.id} is still pending review.`,
        candidateId: eq.id,
        sourceRefs: eq.sourceRefs,
      });
      blockedByPending = true;
    }
  }
  for (const as of candidate.assumptions ?? []) {
    const d = getReviewedDecision(state, 'assumption', as.id);
    if (d === 'pending') {
      pushDiag(ctx, {
        code: 'PIR_BUILD_PENDING_REVIEW_ITEM',
        severity: 'error',
        message: `Assumption ${as.id} is still pending review.`,
        candidateId: as.id,
        sourceRefs: as.sourceRefs,
      });
      blockedByPending = true;
    }
  }
  // Tally error-severity diagnostics.
  let blockedByErrorDiagnostics = false;
  for (const d of candidate.diagnostics ?? []) {
    if (d.severity === 'error') {
      pushDiag(ctx, {
        code: 'PIR_BUILD_ERROR_DIAGNOSTIC_PRESENT',
        severity: 'error',
        message: `candidate carries error diagnostic ${d.code}: ${d.message}`,
      });
      blockedByErrorDiagnostics = true;
    }
  }

  if (blockedByPending || blockedByErrorDiagnostics) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_REVIEW_NOT_READY',
      severity: 'error',
      message:
        'review gate failed — pending items or error diagnostics present. PIR not built.',
    });
    return finaliseRefused(ctx);
  }

  // -------------------------------------------------------------
  // Sprint 85 — hardening pass.
  //
  // Compute a normalised graph summary across the accepted subset,
  // then emit root-cause diagnostics so operators see *why* a
  // build will be empty/partial before the per-item loop fires
  // its cascade. The summary is read-only; it never mutates the
  // candidate or the review state.
  // -------------------------------------------------------------
  const hardeningSummary = summarizeAcceptedGraph(candidate, state);
  for (const d of diagnoseHardenedGraph(candidate, hardeningSummary)) {
    pushDiag(ctx, d);
  }

  // -------------------------------------------------------------
  // Accept / reject pass for IO + equipment + assumptions.
  // -------------------------------------------------------------
  const acceptedIoSignals: IoSignal[] = [];
  for (const io of candidate.io ?? []) {
    const decision = getReviewedDecision(state, 'io', io.id);
    if (decision === 'rejected') {
      ctx.skippedRejected++;
      continue;
    }
    // decision === 'accepted'
    ctx.acceptedIo++;
    const built = buildIoSignal(io, ctx);
    if (built) {
      acceptedIoSignals.push(built);
      ctx.candidateIoIdToPirId.set(io.id, built.id);
      ctx.sourceMap[built.id] = mergeRefs(io.sourceRefs);
    }
  }

  const acceptedEquipment: Equipment[] = [];
  for (const eq of candidate.equipment ?? []) {
    const decision = getReviewedDecision(state, 'equipment', eq.id);
    if (decision === 'rejected') {
      ctx.skippedRejected++;
      continue;
    }
    ctx.acceptedEquipment++;
    const built = buildEquipment(eq, ctx);
    if (built) {
      acceptedEquipment.push(built);
      ctx.sourceMap[built.id] = mergeRefs(eq.sourceRefs);
    }
  }

  for (const as of candidate.assumptions ?? []) {
    const decision = getReviewedDecision(state, 'assumption', as.id);
    if (decision === 'rejected') {
      ctx.skippedRejected++;
      continue;
    }
    // accepted assumption
    ctx.acceptedAssumptions++;
    handleAcceptedAssumption(as, ctx);
  }

  // -------------------------------------------------------------
  // Emit one info diagnostic announcing the placeholder sequence
  // + the sourceMap sidecar.
  // -------------------------------------------------------------
  if (acceptedIoSignals.length === 0 && acceptedEquipment.length === 0) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_EMPTY_ACCEPTED_INPUT',
      severity: 'error',
      message:
        'no accepted IO + equipment to build PIR. Accept at least one item or re-review.',
    });
    return finaliseRefused(ctx);
  }

  pushDiag(ctx, {
    code: 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED',
    severity: 'info',
    message:
      'Sprint 76 v0 emits a placeholder sequence (init → terminal). Real sequence wiring is future work.',
  });
  pushDiag(ctx, {
    code: 'PIR_BUILD_SOURCE_REFS_SIDECAR_USED',
    severity: 'info',
    message:
      'PIR schema does not carry sourceRefs directly; the builder returns a sourceMap sidecar keyed by PIR id.',
  });

  // -------------------------------------------------------------
  // Assemble Project + validate.
  // -------------------------------------------------------------
  const station: Station = {
    id: ctx.options.stationId,
    name: ctx.options.stationName,
    equipment: acceptedEquipment,
    sequence: PLACEHOLDER_SEQUENCE,
    description: 'Sprint 76 review-driven station (placeholder sequence).',
    provenance: provenance(ctx, 'electrical-ingest@sprint-76 review path'),
  };

  const project: Project = {
    pir_version: '0.1.0',
    id: ctx.options.projectId,
    name: ctx.options.projectName,
    description: 'Built from reviewed PirDraftCandidate via Sprint 76 builder.',
    machines: [
      {
        id: ctx.options.machineId,
        name: ctx.options.machineName,
        description: 'Reviewed machine (Sprint 76 v0).',
        stations: [station],
        io: acceptedIoSignals,
        alarms: [],
        interlocks: [],
        parameters: [],
        recipes: [],
        safety_groups: [],
      },
    ],
    provenance: provenance(ctx, 'sprint-76-pir-builder-v0'),
  };

  const report = validatePirProject(project);
  if (!report.ok) {
    for (const issue of report.issues) {
      pushDiag(ctx, {
        code: 'PIR_BUILD_SCHEMA_VALIDATION_FAILED',
        severity: issue.severity,
        message: `[${issue.rule}] ${issue.message}`,
        path: issue.path,
      });
    }
    // Hard schema failure — refuse to surface the invalid PIR.
    if (report.issues.some((i) => i.severity === 'error')) {
      return finaliseRefused(ctx);
    }
  }

  return {
    pir: project,
    diagnostics: ctx.diagnostics,
    sourceMap: ctx.sourceMap,
    acceptedInputCounts: {
      io: ctx.acceptedIo,
      equipment: ctx.acceptedEquipment,
      assumptions: ctx.acceptedAssumptions,
    },
    skippedInputCounts: {
      pending: ctx.skippedPending,
      rejected: ctx.skippedRejected,
      unsupportedAssumptions: ctx.unsupportedAssumptions,
    },
  };
}

function buildIoSignal(
  io: PirIoCandidate,
  ctx: BuildContext,
): IoSignal | null {
  if (!io.address) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_ACCEPTED_IO_MISSING_ADDRESS',
      severity: 'error',
      message: `accepted IO candidate ${io.id} has no address.`,
      candidateId: io.id,
      sourceRefs: io.sourceRefs,
    });
    return null;
  }
  const direction = mapCandidateDirection(io.direction);
  if (!direction) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_ACCEPTED_IO_MISSING_DIRECTION',
      severity: 'error',
      message: `accepted IO candidate ${io.id} has direction ${JSON.stringify(io.direction)}, expected 'input' or 'output'.`,
      candidateId: io.id,
      sourceRefs: io.sourceRefs,
    });
    return null;
  }
  const parsed = parseCandidateAddress(io.address);
  if (!parsed) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_ACCEPTED_IO_INVALID_ADDRESS',
      severity: 'error',
      message: `accepted IO candidate ${io.id} address ${JSON.stringify(io.address)} could not be mapped to PIR IoAddress.`,
      candidateId: io.id,
      sourceRefs: io.sourceRefs,
    });
    return null;
  }
  const id = canonicalisePirId(io.id, 'io');
  const description =
    parsed.descriptionHint ??
    (typeof io.label === 'string' && io.label.length > 0 ? io.label : undefined);
  const signal: IoSignal = {
    id,
    name: io.label ?? id,
    direction,
    data_type: parsed.data_type,
    address: parsed.address,
  };
  if (description) signal.description = description;
  signal.provenance = provenance(ctx);
  return signal;
}

function buildEquipment(
  eq: PirEquipmentCandidate,
  ctx: BuildContext,
): Equipment | null {
  const type = mapCandidateEquipmentKind(eq.kind);
  if (!type) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_UNSUPPORTED_EQUIPMENT_KIND',
      severity: 'error',
      message: `accepted equipment candidate ${eq.id} has kind ${JSON.stringify(eq.kind)}, which has no safe PIR mapping.`,
      candidateId: eq.id,
      sourceRefs: eq.sourceRefs,
    });
    return null;
  }
  const id = canonicalisePirId(eq.id, 'eq');

  // Re-key io ids from candidate-side to PIR-side first.
  const candidateRolesToPirIo: Record<string, string> = {};
  for (const [role, candidateIoId] of Object.entries(eq.ioBindings ?? {})) {
    const pirId = ctx.candidateIoIdToPirId.get(candidateIoId);
    if (!pirId) {
      pushDiag(ctx, {
        code: 'PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID',
        severity: 'error',
        message: `equipment ${eq.id} role ${JSON.stringify(role)} references IO candidate ${JSON.stringify(candidateIoId)} which was not accepted.`,
        candidateId: eq.id,
      });
      return null;
    }
    candidateRolesToPirIo[role] = pirId;
  }

  // Remap candidate generic roles (drive / feedback / drive_1 / ...)
  // into the PIR-canonical role names required by the chosen
  // EquipmentType. Extras (more bindings than the shape supports)
  // become a hard error so we never silently drop wired evidence.
  const { remapped: remappedBindings, extras } = remapEquipmentRoles(
    type,
    candidateRolesToPirIo,
  );
  if (extras.length > 0) {
    pushDiag(ctx, {
      code: 'PIR_BUILD_ACCEPTED_EQUIPMENT_INVALID',
      severity: 'error',
      message: `equipment ${eq.id} (${type}) has more io bindings than the PIR shape supports — extras: ${extras.map((r) => JSON.stringify(r)).join(', ')}.`,
      candidateId: eq.id,
    });
    return null;
  }

  const equipment: Equipment = {
    id,
    name: id,
    type,
    code_symbol: deriveCodeSymbol(eq.id, id),
    io_bindings: remappedBindings,
    provenance: provenance(ctx),
  };
  return equipment;
}

function deriveCodeSymbol(rawId: string, canonicalised: string): string {
  // PIR's `code_symbol` has no specific schema regex but conventional
  // PLC tools expect a short alpha-numeric symbol. We use the original
  // tag if present (e.g. `Y1`), stripping the `device:` / `eq_` prefix.
  const stripped = rawId
    .replace(/^eq_device:/, '')
    .replace(/^device:/, '');
  if (/^[A-Za-z][A-Za-z0-9_]+$/.test(stripped)) return stripped;
  return canonicalised;
}

function handleAcceptedAssumption(
  as: PirMappingAssumption,
  ctx: BuildContext,
): void {
  // Sprint 76: accepted assumptions are NEVER promoted to hard PIR
  // facts. They are recorded in sourceMap (under a synthetic id) +
  // counted under unsupportedAssumptions + warned about. Sprint 77+
  // can expand the mapping table for safe assumption shapes; the
  // architecture insists this stays an explicit list, not a
  // free-form fall-through.
  ctx.unsupportedAssumptions++;
  const id = canonicalisePirId(as.id, 'assum');
  ctx.sourceMap[id] = mergeRefs(as.sourceRefs);
  pushDiag(ctx, {
    code: 'PIR_BUILD_UNSUPPORTED_ASSUMPTION',
    severity: 'warning',
    message: `accepted assumption ${as.id} has no safe PIR mapping in v0; recorded in sourceMap under ${id}.`,
    candidateId: as.id,
    sourceRefs: as.sourceRefs,
  });
}

function mergeRefs(refs: ReadonlyArray<SourceRef> | undefined): SourceRef[] {
  return Array.isArray(refs) ? refs.map((r) => ({ ...r })) : [];
}

function finaliseRefused(ctx: BuildContext): PirBuildResult {
  return {
    pir: undefined,
    diagnostics: ctx.diagnostics,
    sourceMap: ctx.sourceMap,
    acceptedInputCounts: {
      io: ctx.acceptedIo,
      equipment: ctx.acceptedEquipment,
      assumptions: ctx.acceptedAssumptions,
    },
    skippedInputCounts: {
      pending: ctx.skippedPending,
      rejected: ctx.skippedRejected,
      unsupportedAssumptions: ctx.unsupportedAssumptions,
    },
  };
}

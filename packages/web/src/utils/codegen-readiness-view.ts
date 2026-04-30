// Sprint 87B — Codegen readiness view projection.
//
// Pure / DOM-free / total. The Sprint 86 `preflightProject`
// helper in `@plccopilot/codegen-core` returns a flat
// `Diagnostic[]`; the web Codegen-Readiness panel needs a UI-
// ready model:
//   - one overall `status` (`unavailable` / `ready` / `warning`
//     / `blocked`) so the operator sees a verdict at a glance,
//   - severity counts,
//   - diagnostics grouped by `code` (so e.g. duplicate-symbol
//     warnings collapse) and sorted deterministically.
//
// The helper NEVER throws. If the underlying preflight call
// throws (defensive — should not happen in practice), the
// helper returns an `unavailable` view so the UI never
// crashes.
//
// Sprint 87B does NOT block the existing Generate flow. The
// panel is purely informational; the worker-protocol path
// keeps surfacing READINESS_FAILED as a CompileClientError
// after the click for backwards compat.

import {
  preflightProject,
  type CodegenTarget,
} from '@plccopilot/codegen-core';
import type { Project } from '@plccopilot/pir';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CodegenReadinessStatus =
  | 'unavailable'
  | 'ready'
  | 'warning'
  | 'blocked';

export type CodegenReadinessSeverity = 'error' | 'warning' | 'info';

export interface CodegenReadinessItem {
  message: string;
  path?: string;
  stationId?: string;
  symbol?: string;
  hint?: string;
}

export interface CodegenReadinessGroup {
  /** Highest severity present in the group. Always equals each item's severity (groups never mix). */
  severity: CodegenReadinessSeverity;
  /** Diagnostic code shared by every item in the group (e.g. `READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`). */
  code: string;
  /** Operator-facing title derived from the code; falls back to the code itself. */
  title: string;
  items: ReadonlyArray<CodegenReadinessItem>;
}

export interface CodegenReadinessView {
  target: CodegenTarget;
  status: CodegenReadinessStatus;
  /** Severity counts AFTER dedup. Sums match `groups[i].items.length`. */
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  /** One short sentence the panel can render as a verdict / call-to-action. */
  summary: string;
  groups: ReadonlyArray<CodegenReadinessGroup>;
}

export interface BuildCodegenReadinessViewArgs {
  project: Project | null | undefined;
  target: CodegenTarget;
}

// ---------------------------------------------------------------------------
// Code → human title
// ---------------------------------------------------------------------------

const CODE_TITLES: Record<string, string> = {
  READINESS_PIR_EMPTY: 'PIR project is empty',
  READINESS_NO_GENERATABLE_OBJECTS: 'No generatable objects',
  READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET:
    'Equipment kind not supported by this target',
  READINESS_UNSUPPORTED_IO_DATA_TYPE: 'IO data type not supported by target',
  READINESS_UNSUPPORTED_IO_MEMORY_AREA:
    'IO memory area not supported by target',
  READINESS_DUPLICATE_EQUIPMENT_ID: 'Duplicate equipment id',
  READINESS_DUPLICATE_IO_ID: 'Duplicate IO id',
  READINESS_DUPLICATE_IO_ADDRESS: 'Duplicate IO address',
  READINESS_DUPLICATE_GENERATED_SYMBOL: 'Duplicate generated symbol',
  READINESS_PLACEHOLDER_SEQUENCE: 'Placeholder sequence detected',
};

function humanTitle(code: string): string {
  return CODE_TITLES[code] ?? code;
}

// ---------------------------------------------------------------------------
// Defensive preflight wrapper
// ---------------------------------------------------------------------------

interface SafePreflightOk {
  ok: true;
  diagnostics: ReadonlyArray<{
    code: string;
    severity: CodegenReadinessSeverity;
    message: string;
    path?: string;
    stationId?: string;
    symbol?: string;
    hint?: string;
  }>;
}

interface SafePreflightFailure {
  ok: false;
  reason: string;
}

function runSafePreflight(
  project: Project,
  target: CodegenTarget,
): SafePreflightOk | SafePreflightFailure {
  try {
    const result = preflightProject(project, { target });
    return { ok: true, diagnostics: result.diagnostics };
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : 'unknown error';
    return {
      ok: false,
      reason: `preflightProject threw: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Sort + dedup
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<CodegenReadinessSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function sortDiagnosticsForView(
  diags: SafePreflightOk['diagnostics'],
): SafePreflightOk['diagnostics'] {
  return diags.slice().sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    const path = (a.path ?? '').localeCompare(b.path ?? '');
    if (path !== 0) return path;
    const sym = (a.symbol ?? '').localeCompare(b.symbol ?? '');
    if (sym !== 0) return sym;
    const stn = (a.stationId ?? '').localeCompare(b.stationId ?? '');
    if (stn !== 0) return stn;
    return a.message.localeCompare(b.message);
  });
}

function dedupKey(d: {
  code: string;
  severity: CodegenReadinessSeverity;
  message: string;
  path?: string;
  symbol?: string;
  stationId?: string;
}): string {
  return [
    d.code,
    d.severity,
    d.path ?? '',
    d.symbol ?? '',
    d.stationId ?? '',
    d.message,
  ].join('|');
}

// ---------------------------------------------------------------------------
// Public helper
// ---------------------------------------------------------------------------

/**
 * Sprint 87B — project a `Project` + `target` into a UI-ready
 * readiness view. Pure / total / no mutation. The helper never
 * throws; on unexpected preflight failure it returns an
 * `unavailable` view with a synthetic info group so the UI can
 * still render something safe.
 */
export function buildCodegenReadinessView(
  args: BuildCodegenReadinessViewArgs,
): CodegenReadinessView {
  const { project, target } = args;

  if (project == null || typeof project !== 'object') {
    return {
      target,
      status: 'unavailable',
      blockingCount: 0,
      warningCount: 0,
      infoCount: 0,
      summary: `No PIR preview yet. Build a PIR before checking ${target} readiness.`,
      groups: [],
    };
  }

  const safe = runSafePreflight(project, target);
  if (!safe.ok) {
    return {
      target,
      status: 'unavailable',
      blockingCount: 0,
      warningCount: 0,
      infoCount: 0,
      summary: `${target} readiness check is unavailable.`,
      groups: [
        {
          severity: 'info',
          code: 'READINESS_CHECK_UNAVAILABLE',
          title: 'Readiness check unavailable',
          items: [{ message: safe.reason }],
        },
      ],
    };
  }

  const sorted = sortDiagnosticsForView(safe.diagnostics);

  // Defensive dedup — preflight already dedups, but a future
  // call site could merge sources without re-running it. Keep
  // the first occurrence per identity tuple.
  type SortedDiag = (typeof sorted)[number];
  const seen = new Set<string>();
  const deduped: SortedDiag[] = [];
  for (const d of sorted) {
    const k = dedupKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(d);
  }

  let blockingCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const d of deduped) {
    if (d.severity === 'error') blockingCount++;
    else if (d.severity === 'warning') warningCount++;
    else infoCount++;
  }

  // Group by (severity, code). Items inside a group keep the
  // sorted order from above.
  const groupOrder: string[] = [];
  const groupMap = new Map<
    string,
    {
      severity: CodegenReadinessSeverity;
      code: string;
      items: CodegenReadinessItem[];
    }
  >();
  for (const d of deduped) {
    const key = `${d.severity}|${d.code}`;
    let group = groupMap.get(key);
    if (!group) {
      group = { severity: d.severity, code: d.code, items: [] };
      groupMap.set(key, group);
      groupOrder.push(key);
    }
    const item: CodegenReadinessItem = { message: d.message };
    if (d.path) item.path = d.path;
    if (d.stationId) item.stationId = d.stationId;
    if (d.symbol) item.symbol = d.symbol;
    if (d.hint) item.hint = d.hint;
    group.items.push(item);
  }
  const groups: CodegenReadinessGroup[] = groupOrder.map((k) => {
    const g = groupMap.get(k)!;
    return {
      severity: g.severity,
      code: g.code,
      title: humanTitle(g.code),
      items: g.items,
    };
  });

  let status: CodegenReadinessStatus;
  let summary: string;
  if (blockingCount > 0) {
    status = 'blocked';
    summary =
      blockingCount === 1
        ? `Not ready for ${target} generation — 1 blocking issue.`
        : `Not ready for ${target} generation — ${blockingCount} blocking issues.`;
  } else if (warningCount > 0) {
    status = 'warning';
    summary =
      warningCount === 1
        ? `Ready for ${target} generation with 1 warning.`
        : `Ready for ${target} generation with ${warningCount} warnings.`;
  } else {
    status = 'ready';
    summary = `Ready for ${target} generation.`;
  }

  return {
    target,
    status,
    blockingCount,
    warningCount,
    infoCount,
    summary,
    groups,
  };
}

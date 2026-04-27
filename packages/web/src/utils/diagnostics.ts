import type {
  ArtifactDiagnostic,
  GeneratedArtifact,
} from '@plccopilot/codegen-core';

const SEVERITY_RANK: Record<ArtifactDiagnostic['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  info: number;
}

export function aggregateDiagnostics(
  diagnostics: readonly ArtifactDiagnostic[],
): DiagnosticCounts {
  const out: DiagnosticCounts = { errors: 0, warnings: 0, info: 0 };
  for (const d of diagnostics) {
    if (d.severity === 'error') out.errors++;
    else if (d.severity === 'warning') out.warnings++;
    else if (d.severity === 'info') out.info++;
  }
  return out;
}

/**
 * Sort diagnostics by (severity, code, stationId, path, symbol, message).
 * Same order the codegen-core pipeline already uses; replicated here so
 * the UI can re-sort lists after merging across backends without depending
 * on the import.
 */
export function sortDiagnosticsForDisplay(
  diagnostics: readonly ArtifactDiagnostic[],
): ArtifactDiagnostic[] {
  return diagnostics.slice().sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    const stn = (a.stationId ?? '').localeCompare(b.stationId ?? '');
    if (stn !== 0) return stn;
    const pth = (a.path ?? '').localeCompare(b.path ?? '');
    if (pth !== 0) return pth;
    const sym = (a.symbol ?? '').localeCompare(b.symbol ?? '');
    if (sym !== 0) return sym;
    return a.message.localeCompare(b.message);
  });
}

/**
 * Deduplicate by (code, severity, path, stationId, symbol, message). The
 * same diagnostic surfaces both on a station-FB artifact and inside the
 * manifest's `compiler_diagnostics`; the UI shouldn't show the duplicate.
 */
export function dedupeDiagnostics(
  diagnostics: readonly ArtifactDiagnostic[],
): ArtifactDiagnostic[] {
  const seen = new Set<string>();
  const out: ArtifactDiagnostic[] = [];
  for (const d of diagnostics) {
    const key = [
      d.code,
      d.severity,
      d.path ?? '',
      d.stationId ?? '',
      d.symbol ?? '',
      d.message,
    ].join('§');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

// =============================================================================
// Sprint 44 — gather every diagnostic from a CompileResult artifact bundle
// =============================================================================

const VALID_SEVERITIES = new Set<ArtifactDiagnostic['severity']>([
  'error',
  'warning',
  'info',
]);

function isValidSeverity(
  v: unknown,
): v is ArtifactDiagnostic['severity'] {
  return typeof v === 'string' && VALID_SEVERITIES.has(v as never);
}

/**
 * Sprint 44 — best-effort parse of one entry from a manifest's
 * `compiler_diagnostics` array. Manifest JSON uses snake-case keys
 * (`station_id`) while the in-memory `ArtifactDiagnostic` shape is
 * camelCase (`stationId`); we normalise here so the panel doesn't
 * have to branch.
 *
 * Returns `null` for malformed entries (missing required fields,
 * unknown severity, non-string code/message). The caller filters
 * those out — a single bad row in a manifest must never break the
 * whole panel.
 */
function parseManifestDiagnostic(value: unknown): ArtifactDiagnostic | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string') return null;
  if (typeof v.message !== 'string') return null;
  if (!isValidSeverity(v.severity)) return null;
  const out: ArtifactDiagnostic = {
    code: v.code,
    severity: v.severity,
    message: v.message,
  };
  // station_id (snake) → stationId (camel). Accept either if both are
  // present, snake wins because that's the wire format.
  const station =
    typeof v.station_id === 'string'
      ? v.station_id
      : typeof v.stationId === 'string'
        ? v.stationId
        : undefined;
  if (station) out.stationId = station;
  if (typeof v.path === 'string' && v.path.length > 0) out.path = v.path;
  if (typeof v.symbol === 'string' && v.symbol.length > 0)
    out.symbol = v.symbol;
  if (typeof v.hint === 'string' && v.hint.length > 0) out.hint = v.hint;
  return out;
}

/**
 * Sprint 44 — single source of truth for "every compiler diagnostic
 * the user should see after Generate".
 *
 *   - Each `artifact.diagnostics` array is included verbatim.
 *   - The manifest artifact (`*manifest.json`) is parsed and its
 *     `compiler_diagnostics` array (if any) is decoded into
 *     `ArtifactDiagnostic` shape.
 *   - Snake-case keys (`station_id`) from the manifest are mapped to
 *     camelCase.
 *   - Malformed manifest JSON, missing arrays, or rows with bad
 *     fields are silently dropped — a single bad row never breaks
 *     the panel.
 *   - Output is deduplicated via the existing `dedupeDiagnostics`
 *     so a diagnostic that appears on both an artifact AND the
 *     manifest counts once.
 *   - Input is never mutated.
 */
export function diagnosticsFromGeneratedArtifacts(
  artifacts: readonly GeneratedArtifact[],
): ArtifactDiagnostic[] {
  const collected: ArtifactDiagnostic[] = [];

  for (const artifact of artifacts) {
    if (artifact.diagnostics) {
      collected.push(...artifact.diagnostics);
    }
    if (artifact.path.endsWith('manifest.json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(artifact.content);
      } catch {
        // Malformed manifest — skip its diagnostics, keep artifact ones.
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const m = parsed as Record<string, unknown>;
      const raw = m.compiler_diagnostics;
      if (!Array.isArray(raw)) continue;
      for (const entry of raw) {
        const d = parseManifestDiagnostic(entry);
        if (d) collected.push(d);
      }
    }
  }

  return dedupeDiagnostics(collected);
}

import JSZip from 'jszip';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';

/**
 * Trigger a browser download of a single text payload. Cleans up the blob
 * URL on the next tick so the browser has time to start the download.
 */
export function downloadText(
  filename: string,
  content: string,
  mime = 'text/plain',
): void {
  const blob = new Blob([content], { type: mime });
  triggerDownload(filename, blob);
}

/**
 * Bundle every artifact into a single JSON file the user can re-ingest
 * (e.g., feed back into the CLI as a fixture).
 *
 *   {
 *     "artifacts": [
 *       { "path": "siemens/FB_StLoad.scl", "kind": "scl", "content": "…" },
 *       …
 *     ]
 *   }
 */
export function downloadArtifactBundle(
  artifacts: readonly GeneratedArtifact[],
): void {
  const payload = {
    artifacts: artifacts.map((a) => ({
      path: a.path,
      kind: a.kind,
      content: a.content,
      ...(a.diagnostics ? { diagnostics: a.diagnostics } : {}),
    })),
  };
  downloadText(
    'plccopilot-bundle.json',
    JSON.stringify(payload, null, 2),
    'application/json',
  );
}

// =============================================================================
// ZIP download
// =============================================================================

/**
 * Reject obviously-unsafe artifact paths. The web app already trusts paths
 * coming from `@plccopilot/codegen-*` (which produce them deterministically),
 * but we double-check here so a future codegen bug or a hand-edited bundle
 * cannot trick the browser into writing outside the intended layout.
 */
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return false;       // absolute (POSIX)
  if (/^[A-Za-z]:[\\/]/.test(p)) return false; // absolute (Windows)
  // Reject any `..` segment regardless of separator.
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '..') return false;
  }
  return true;
}

export interface BuildArtifactsZipOptions {
  /** Optional summary object written as `summary.json` at the zip root. */
  summary?: Record<string, unknown>;
}

/**
 * Build (but do not download) a JSZip instance containing every artifact.
 * Pure-ish — no DOM access — so unit tests can inspect the entry list via
 * `Object.keys(zip.files)` without going through Blob APIs.
 *
 * Throws on the first unsafe path so the caller can surface a clear error
 * before any partial download starts.
 */
export function buildArtifactsZip(
  artifacts: ReadonlyArray<GeneratedArtifact>,
  options: BuildArtifactsZipOptions = {},
): JSZip {
  const zip = new JSZip();

  for (const a of artifacts) {
    if (!isSafeRelativePath(a.path)) {
      throw new Error(
        `unsafe artifact path: "${a.path}" (absolute or contains "..")`,
      );
    }
    // `createFolders: false` keeps `Object.keys(zip.files)` as the
    // bare set of artifact paths — JSZip otherwise auto-injects an
    // entry per intermediate directory (`siemens/`, `codesys/`, …)
    // which inflates the manifest and surprises consumers iterating
    // the entry list.
    zip.file(a.path, a.content, { createFolders: false });
  }

  if (options.summary) {
    zip.file('summary.json', JSON.stringify(options.summary, null, 2), {
      createFolders: false,
    });
  }

  return zip;
}

/**
 * Generate a `plccopilot-artifacts.zip` from the artifacts list and trigger
 * a browser download. Returns when the download has been initiated.
 */
export async function downloadArtifactsZip(
  artifacts: ReadonlyArray<GeneratedArtifact>,
  filename = 'plccopilot-artifacts.zip',
  options?: BuildArtifactsZipOptions,
): Promise<void> {
  const zip = buildArtifactsZip(artifacts, options);
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(filename, blob);
}

// =============================================================================
// Internal — synthetic-click download trigger
// =============================================================================

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

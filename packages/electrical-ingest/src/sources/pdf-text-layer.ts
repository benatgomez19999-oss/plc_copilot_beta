// Sprint 80 — pdfjs-dist adapter for PDF text-layer extraction.
//
// This file is the ONLY surface in the codebase that imports
// pdfjs-dist. Every consumer goes through `extractPdfTextLayer`,
// which:
//
//   - dynamic-imports the pdfjs-dist *legacy* build (the one
//     officially supported under Node — the default ESM build
//     requires `DOMMatrix` which doesn't exist outside browsers),
//   - disables features that need browser APIs (workers, font
//     faces, eval),
//   - never throws: every failure mode (dependency-load failure,
//     parse failure, encrypted PDF, per-page extraction failure)
//     is mapped to a structured `ElectricalDiagnostic` and a
//     boolean flag on the result.
//
// The PDF coordinate system is bottom-left origin, point (1/72 inch)
// unit. We convert each text item's affine `transform` into a
// `PdfBoundingBox` with `unit: 'pt'`. The y coordinate that pdfjs
// gives is the *baseline*, not the visual top — line-grouping
// downstream (`pdf-text-normalize.ts`) clusters by baseline Y.
//
// What this adapter is NOT responsible for:
//
//   - Line/table grouping (lives in `pdf-text-normalize.ts`).
//   - Electrical interpretation (lives in `pdf.ts`).
//   - Web wiring or UI.
//   - Persistence.
//
// Keep this file isolated; future swaps to a different parser
// (mupdf, etc.) only need to re-implement `extractPdfTextLayer`.

import { createElectricalDiagnostic } from '../diagnostics.js';
import type { ElectricalDiagnostic } from '../types.js';

export interface PdfTextLayerExtractionInput {
  bytes: Uint8Array;
  /**
   * Hard cap on how many pages the adapter will walk. Pages beyond
   * `maxPages` are not requested at all (saves CPU + memory on
   * large drawings). Default: caller-supplied.
   */
  maxPages?: number;
}

export interface PdfTextLayerItem {
  /** Verbatim text for this item — pdfjs returns one item per glyph run. */
  text: string;
  /** Lower-left x in PDF point space. */
  x: number;
  /** Baseline y in PDF point space (origin: bottom-left of page). */
  y: number;
  /** Item width in PDF points (pdfjs `width`). */
  width: number;
  /** Item height in PDF points (pdfjs `height`). */
  height: number;
  /** Approximate font size derived from the item's transform. */
  fontSize?: number;
}

export interface PdfTextLayerPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextLayerItem[];
  diagnostics: ElectricalDiagnostic[];
}

export interface PdfTextLayerExtractionResult {
  /** True iff the parser opened the document and extraction proceeded. */
  ok: boolean;
  pages: PdfTextLayerPage[];
  diagnostics: ElectricalDiagnostic[];
  /** True iff the dynamic import of pdfjs-dist itself failed. */
  dependencyFailed: boolean;
  /** True iff `getDocument().promise` threw (malformed bytes, unsupported features). */
  parseFailed: boolean;
  /** True iff the PDF reported itself as encrypted. */
  encrypted: boolean;
  /**
   * Document-level metadata when the parser surfaced any. Mostly
   * `pageCount` is reliable; the others are pdfjs `info` mirrors.
   */
  pageCount: number;
}

/**
 * Cached pdfjs-dist module reference. The legacy build is ESM and
 * has noticeable load time (~hundreds of ms in Node), so we
 * memoise the import across calls.
 */
let pdfjsModulePromise:
  | Promise<{
      getDocument: (options: unknown) => { promise: Promise<unknown>; destroy: () => Promise<void> };
      PasswordException?: new (...args: unknown[]) => Error;
    }>
  | null = null;

async function loadPdfjs(): Promise<unknown> {
  if (!pdfjsModulePromise) {
    // The legacy build is the only supported entry under Node;
    // see https://github.com/mozilla/pdf.js/issues/14807.
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<{
      getDocument: (options: unknown) => { promise: Promise<unknown>; destroy: () => Promise<void> };
      PasswordException?: new (...args: unknown[]) => Error;
    }>;
  }
  return pdfjsModulePromise;
}

// Strict subset of pdfjs's API we actually use — pulled out so we
// don't depend on its full d.ts surface (which churns between
// majors).
interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface PdfJsTextContent {
  items: Array<PdfJsTextItem | { type?: string }>;
}

interface PdfJsPage {
  getViewport(args: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<PdfJsTextContent>;
}

interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(options: unknown): PdfJsLoadingTask;
  PasswordException?: new (...args: unknown[]) => Error;
}

/**
 * Run the pdfjs-dist text-layer extractor against `input.bytes` and
 * return a structured result. NEVER throws — every error path
 * lands in the `diagnostics` field and a corresponding flag.
 */
export async function extractPdfTextLayer(
  input: PdfTextLayerExtractionInput,
): Promise<PdfTextLayerExtractionResult> {
  const result: PdfTextLayerExtractionResult = {
    ok: false,
    pages: [],
    diagnostics: [],
    dependencyFailed: false,
    parseFailed: false,
    encrypted: false,
    pageCount: 0,
  };

  if (!(input?.bytes instanceof Uint8Array) || input.bytes.length === 0) {
    return result;
  }

  let mod: PdfJsModule;
  try {
    mod = (await loadPdfjs()) as PdfJsModule;
  } catch (err) {
    result.dependencyFailed = true;
    result.diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_DEPENDENCY_LOAD_FAILED',
        message: `Failed to load pdfjs-dist: ${formatError(err)}`,
        hint:
          'Sprint 80 v0 ships pdfjs-dist@5.x. Re-run `pnpm install` or pin the dependency. The ingestor will fall back to the test-mode text path when text input is also supplied.',
      }),
    );
    return result;
  }

  // pdfjs reads the bytes lazily; we hand it a *copy* so the
  // caller's buffer can't be mutated.
  const data = new Uint8Array(input.bytes);
  const loadingTask = mod.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // Standard fonts are needed for *rendering*, not text
    // extraction. Skip them so Node doesn't try to fetch
    // resources from a `standardFontDataUrl` we never set.
    useWorkerFetch: false,
  });

  let doc: PdfJsDocument;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    // Encrypted detection: pdfjs throws a PasswordException when
    // the PDF asks for a password and none was supplied. We catch
    // it by name match (the constructor reference is exported but
    // unreliable across pdfjs majors).
    const isPasswordEx =
      (mod.PasswordException && err instanceof mod.PasswordException) ||
      (err instanceof Error && err.name === 'PasswordException');
    if (isPasswordEx) {
      result.encrypted = true;
      result.diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_ENCRYPTED_NOT_SUPPORTED',
          message: 'PDF is password-protected; Sprint 80 v0 cannot ingest encrypted documents.',
        }),
      );
    } else {
      result.parseFailed = true;
      result.diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_TEXT_LAYER_EXTRACTION_FAILED',
          message: `pdfjs failed to open the PDF: ${formatError(err)}`,
          hint:
            'The bytes started with %PDF- but the document body was not parseable. The ingestor will fall back to the test-mode text path when text input is also supplied.',
        }),
      );
    }
    await safeDestroy(loadingTask);
    return result;
  }

  result.pageCount = doc.numPages;
  const max =
    typeof input.maxPages === 'number' && input.maxPages > 0
      ? Math.min(input.maxPages, doc.numPages)
      : doc.numPages;

  for (let n = 1; n <= max; n++) {
    const pageDiags: ElectricalDiagnostic[] = [];
    let page: PdfJsPage;
    try {
      page = await doc.getPage(n);
    } catch (err) {
      pageDiags.push(
        createElectricalDiagnostic({
          code: 'PDF_TEXT_LAYER_EXTRACTION_FAILED',
          message: `Failed to load page ${n}: ${formatError(err)}`,
        }),
      );
      result.pages.push({
        pageNumber: n,
        width: 0,
        height: 0,
        items: [],
        diagnostics: pageDiags,
      });
      result.diagnostics.push(...pageDiags);
      continue;
    }
    const viewport = page.getViewport({ scale: 1 });
    let raw: PdfJsTextContent;
    try {
      raw = await page.getTextContent();
    } catch (err) {
      pageDiags.push(
        createElectricalDiagnostic({
          code: 'PDF_TEXT_LAYER_EXTRACTION_FAILED',
          message: `Failed to read text content for page ${n}: ${formatError(err)}`,
        }),
      );
      result.pages.push({
        pageNumber: n,
        width: viewport.width,
        height: viewport.height,
        items: [],
        diagnostics: pageDiags,
      });
      result.diagnostics.push(...pageDiags);
      continue;
    }

    const items: PdfTextLayerItem[] = [];
    for (const raw_ of raw.items ?? []) {
      const ti = raw_ as PdfJsTextItem;
      if (typeof ti.str !== 'string' || ti.str.length === 0) continue;
      const transform = Array.isArray(ti.transform) ? ti.transform : [];
      const x = numberOrZero(transform[4]);
      const y = numberOrZero(transform[5]);
      const fontSize = Math.abs(numberOrZero(transform[3])) || undefined;
      items.push({
        text: ti.str,
        x,
        y,
        width: numberOrZero(ti.width),
        height: numberOrZero(ti.height),
        fontSize,
      });
    }

    if (items.length === 0) {
      pageDiags.push(
        createElectricalDiagnostic({
          code: 'PDF_TEXT_LAYER_EMPTY_PAGE',
          message: `Page ${n} has no extractable text — typical for scanned/image-only pages.`,
        }),
      );
    }

    result.pages.push({
      pageNumber: n,
      width: viewport.width,
      height: viewport.height,
      items,
      diagnostics: pageDiags,
    });
    result.diagnostics.push(...pageDiags);
  }

  if (max < doc.numPages) {
    result.diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_PAGE_LIMIT_EXCEEDED',
        message: `Page limit of ${max} reached; ${doc.numPages - max} page(s) ignored.`,
      }),
    );
  }

  result.ok = true;
  await safeDestroy(loadingTask);
  return result;
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const detail = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
    return `${detail}${err.message}`;
  }
  try {
    return String(err);
  } catch {
    return '<unknown error>';
  }
}

async function safeDestroy(task: PdfJsLoadingTask): Promise<void> {
  try {
    await task.destroy();
  } catch {
    // Best-effort cleanup. pdfjs sometimes throws on destroy()
    // when the document failed to load — not actionable.
  }
}

/**
 * Test-only hook: clear the memoised module so a subsequent test
 * can simulate a fresh dynamic import (e.g., to verify the
 * dependency-failure path). Not part of the package's public
 * runtime API.
 */
export function __resetPdfjsModuleCacheForTests(): void {
  pdfjsModulePromise = null;
}

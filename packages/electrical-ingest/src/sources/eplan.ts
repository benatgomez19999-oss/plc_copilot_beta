// Sprint 72 — EPLAN source ingestion *interfaces* + an honest
// unsupported stub. No EPLAN format is parsed in this sprint; the
// architecture says so explicitly via the
// `UNSUPPORTED_SOURCE_FEATURE` diagnostics the stub returns.
//
// Trademark note: this file ingests files *exported by* EPLAN
// software. The PLC Copilot project is not affiliated with or
// endorsed by EPLAN GmbH & Co. KG. The format names below
// (`xml`/`edz`/`pdf`/`csv`) refer to file containers, not vendor
// schemas, so the stub doesn't bind to anything proprietary.

import { createElectricalDiagnostic } from '../diagnostics.js';
import type {
  ElectricalDiagnostic,
  ElectricalGraph,
  EplanIngestionInput,
  EplanIngestionResult,
  EplanIngestor,
} from '../types.js';

// Re-export the public interface types so callers can `import { ... }
// from '@plccopilot/electrical-ingest'` once the barrel exports are
// in place.
export type {
  EplanIngestor,
  EplanIngestionInput,
  EplanIngestionOptions,
  EplanIngestionResult,
  EplanSourceFile,
} from '../types.js';

function emptyGraph(input: EplanIngestionInput): ElectricalGraph {
  return {
    id: input.sourceId ?? 'unknown',
    sourceKind: 'eplan-export',
    nodes: [],
    edges: [],
    diagnostics: [],
    metadata: {
      sourceFiles: input.files.map((f) => f.path),
      generator: 'electrical-ingest@unsupported-stub',
    },
  };
}

/**
 * Build the unsupported-stub ingestor. It NEVER throws and NEVER
 * invents data; instead it returns an empty graph + diagnostics
 * that label the request as `UNSUPPORTED_SOURCE_FEATURE`. The
 * canIngest predicate returns true only for known file extensions
 * (so the stub can stand in until a real ingestor takes over) but
 * the `ingest` step refuses to make claims.
 */
export function createUnsupportedEplanIngestor(): EplanIngestor {
  return {
    canIngest(input: EplanIngestionInput): boolean {
      if (!input || typeof input !== 'object') return false;
      if (!Array.isArray(input.files) || input.files.length === 0) return false;
      return input.files.every(
        (f) =>
          f &&
          typeof f === 'object' &&
          (f.kind === 'xml' ||
            f.kind === 'edz' ||
            f.kind === 'pdf' ||
            f.kind === 'csv' ||
            f.kind === 'unknown'),
      );
    },

    async ingest(input: EplanIngestionInput): Promise<EplanIngestionResult> {
      const diagnostics: ElectricalDiagnostic[] = [];
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'UNSUPPORTED_SOURCE_FEATURE',
          message:
            'EPLAN-format ingestion is not implemented yet — this is the Sprint 72 stub. See docs/electrical-ingestion-architecture.md.',
          hint:
            'Use the manual graph constructor, or wait for the structured-export parser scheduled for a future sprint.',
        }),
      );
      // If files were specified, surface a per-file info diagnostic
      // so the operator sees exactly which inputs the stub saw.
      if (Array.isArray(input.files)) {
        for (const f of input.files) {
          if (!f || typeof f !== 'object') continue;
          diagnostics.push(
            createElectricalDiagnostic({
              code: 'UNSUPPORTED_SOURCE_FEATURE',
              severity: 'info',
              message: `EPLAN file ${JSON.stringify(f.path)} (kind ${JSON.stringify(f.kind)}) ignored: stub ingestor.`,
              sourceRef: {
                sourceId: input.sourceId,
                kind: 'eplan-export',
                path: f.path,
              },
            }),
          );
        }
      }
      const graph: ElectricalGraph = {
        ...emptyGraph(input),
        diagnostics: [...diagnostics],
      };
      return { graph, diagnostics };
    },
  };
}

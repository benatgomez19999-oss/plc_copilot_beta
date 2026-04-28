// Sprint 72 — generic source registry. A future ingestor (CSV
// terminal list, EPLAN XML, manual graph builder) registers itself
// here so the orchestrator can dispatch based on `canIngest`. Sprint
// 72 only ships the registry shell + the unsupported-EPLAN stub
// installed by default, so consumers wiring this layer get sensible
// defaults from day one.

import { createUnsupportedEplanIngestor } from './eplan.js';
import type { EplanIngestionInput, EplanIngestor, EplanIngestionResult } from '../types.js';

export interface SourceRegistry {
  register(ingestor: EplanIngestor): void;
  /**
   * Find the first ingestor whose `canIngest` returns true. Returns
   * null when no ingestor handles the input — the orchestrator
   * should then surface an `UNSUPPORTED_SOURCE_FEATURE` diagnostic.
   */
  resolve(input: EplanIngestionInput): EplanIngestor | null;
  list(): readonly EplanIngestor[];
}

export function createSourceRegistry(): SourceRegistry {
  const ingestors: EplanIngestor[] = [];
  return {
    register(ingestor: EplanIngestor): void {
      if (!ingestor || typeof ingestor.canIngest !== 'function') {
        throw new Error(
          'createSourceRegistry: register() requires an EplanIngestor with a canIngest method.',
        );
      }
      ingestors.push(ingestor);
    },
    resolve(input: EplanIngestionInput): EplanIngestor | null {
      for (const i of ingestors) {
        try {
          if (i.canIngest(input)) return i;
        } catch {
          // A canIngest implementation should never throw, but if it
          // does, we treat it as "no" rather than poisoning the
          // dispatch.
          continue;
        }
      }
      return null;
    },
    list(): readonly EplanIngestor[] {
      return [...ingestors];
    },
  };
}

/**
 * Convenience: build a registry with the Sprint 72 default
 * unsupported-EPLAN stub already installed. Callers can register
 * additional ingestors (CSV, manual, real-EPLAN) in front of it.
 */
export function createDefaultSourceRegistry(): SourceRegistry {
  const reg = createSourceRegistry();
  reg.register(createUnsupportedEplanIngestor());
  return reg;
}

/**
 * Drive an ingestion against a registry. Returns the resolved
 * ingestor's result (which may carry diagnostics) or — when no
 * ingestor matches — a synthetic result with a single
 * `UNSUPPORTED_SOURCE_FEATURE` diagnostic, mirroring the contract
 * the unsupported stub follows.
 */
export async function ingestWithRegistry(
  registry: SourceRegistry,
  input: EplanIngestionInput,
): Promise<EplanIngestionResult> {
  const ingestor = registry.resolve(input);
  if (ingestor) return ingestor.ingest(input);
  // No ingestor — fall through to the unsupported stub for an
  // honest empty result.
  return createUnsupportedEplanIngestor().ingest(input);
}

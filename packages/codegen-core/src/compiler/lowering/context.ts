/**
 * Sprint 42 — minimal "where am I in the PIR tree" record threaded
 * through the lowering pipeline. Every emitter that wants to attach
 * a real `machines[i].stations[j]…` JSON path receives this, instead
 * of relying on the FB-name string that Sprint 41 left as a
 * placeholder.
 *
 * The context is intentionally tiny — just the two indices the
 * pipeline actually needs to compose path strings. Adding more
 * fields (e.g. `stationId`) would be redundant: callers always have
 * the live `Station` object beside this context, so they can read
 * `station.id` directly. Keeping the surface narrow makes
 * back-compat easy: existing callers that don't yet pass a context
 * don't see any breaking change.
 *
 * `null` / absent context means "I don't know where I am in the
 * tree" — emitters fall back to whatever `path` they already had
 * (typically the FB artifact name). No path is invented.
 */
export interface LoweringPathContext {
  machineIndex: number;
  stationIndex: number;
}

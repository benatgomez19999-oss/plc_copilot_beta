/**
 * Identifier of an emission target. Used by the IR renderers and the symbol
 * layer to choose lexical conventions (scoping prefixes, comment markers,
 * DB namespace mapping).
 *
 *   siemens   — TIA Portal SCL (S7-1500). Mature.
 *   codesys   — IEC 61131-3 ST (Codesys 3.x). POC, .st text only.
 *   rockwell  — Studio 5000 ST (Logix 5000). EXPERIMENTAL POC; .st text only.
 *               Edge triggers lower to one-shot bit pattern. Timers stay
 *               pseudo-IEC and emit a ROCKWELL_TIMER_PSEUDO_IEC warning.
 *               No L5X export, no AOI packaging — see
 *               ROCKWELL_NO_L5X_EXPORT diagnostic.
 *
 * Adding B&R / Beckhoff / Schneider in a future sprint will extend this union.
 */
export type BackendId = 'siemens' | 'codesys' | 'rockwell';

export const SIEMENS: BackendId = 'siemens';
export const CODESYS: BackendId = 'codesys';
export const ROCKWELL: BackendId = 'rockwell';

import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '../types.js';
import { buildDbParamsIR } from '../compiler/program/data-blocks.js';
import { renderDataBlockSiemens } from '../compiler/renderers/data-blocks.js';

/**
 * Reusable scalar render — used by db-recipes.ts. Mirrors what
 * `buildDbParamsIR` writes into `DataFieldIR.initialValue`.
 */
export function renderScalarValue(
  dtype: string,
  value: number | boolean | string,
): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (dtype === 'real') {
    const s = String(value);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }
  return String(value);
}

/** Backward-compat facade — builds IR + renders Siemens. */
export function generateDbGlobalParams(
  project: Project,
): GeneratedArtifact | null {
  const dbIr = buildDbParamsIR(project);
  if (!dbIr) return null;
  const rendered = renderDataBlockSiemens(dbIr);
  return { path: rendered.path, kind: 'scl', content: rendered.content };
}

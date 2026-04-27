import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '../types.js';
import { SIEMENS_DIR } from '../naming.js';
import { buildDbAlarmsIR } from '../compiler/program/data-blocks.js';
import { renderDataBlockSiemens } from '../compiler/renderers/data-blocks.js';

export const DB_ALARMS_NAME = 'DB_Alarms';
export const DB_ALARMS_PATH = `${SIEMENS_DIR}/${DB_ALARMS_NAME}.scl`;

/**
 * Backward-compat facade. Builds the DataBlockArtifactIR via the structured
 * builder and renders Siemens text. New code should consume the IR directly
 * (via `compileProject(...)` → `program.dataBlocks`).
 */
export function generateDbAlarms(project: Project): GeneratedArtifact | null {
  const dbIr = buildDbAlarmsIR(project);
  if (!dbIr) return null;
  const rendered = renderDataBlockSiemens(dbIr);
  return { path: rendered.path, kind: 'scl', content: rendered.content };
}

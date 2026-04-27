import type { EquipmentType, Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '../types.js';
import {
  buildEquipmentTypesIR,
  siemensTypeName,
} from '../compiler/program/types.js';
import { renderTypeArtifactSiemens } from '../compiler/renderers/types.js';

export { udtArtifactPath, udtName } from '../naming.js';

/**
 * Backward-compat facade. Builds the structured TypeArtifactIR list and
 * renders Siemens UDTs. New code should consume `compileProject(...)
 * .typeArtifacts` directly.
 */
export function generateUdts(project: Project): GeneratedArtifact[] {
  return buildEquipmentTypesIR(project).map((t) => {
    const r = renderTypeArtifactSiemens(t);
    return { path: r.path, kind: 'scl', content: r.content };
  });
}

/** @deprecated kept for backward compat — prefer `siemensTypeName(eqType)`. */
export function siemensUdtNameForEquipment(
  eqType: EquipmentType,
): string | null {
  return siemensTypeName(eqType);
}

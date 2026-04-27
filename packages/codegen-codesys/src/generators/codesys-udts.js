import { buildEquipmentTypesIR, codesysTypeName, } from '@plccopilot/codegen-core';
import { renderTypeArtifactCodesys } from '../renderers/types.js';
import { CODESYS_DIR } from '../naming.js';
export { CODESYS_DIR };
/**
 * Builds the structured TypeArtifactIR list and renders Codesys DUTs from
 * the same canonical source of truth as the Siemens / Rockwell backends.
 */
export function generateCodesysDuts(project) {
    return buildEquipmentTypesIR(project).map((t) => {
        const r = renderTypeArtifactCodesys(t);
        return { path: r.path, kind: 'st', content: r.content };
    });
}
/** Map the canonical IR UDT name (`UDT_*`) to its Codesys DUT counterpart. */
export function dutName(canonicalName) {
    return codesysTypeName(canonicalName);
}

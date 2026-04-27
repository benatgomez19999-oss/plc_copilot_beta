import { buildDbAlarmsIR, buildDbParamsIR, buildDbRecipesIR, } from '@plccopilot/codegen-core';
import { renderDataBlockCodesys } from '../renderers/data-blocks.js';
/**
 * Each function builds the structured DataBlockArtifactIR via the core
 * builder and runs the Codesys GVL renderer — single IR source of truth,
 * Codesys-side rendering.
 */
export function generateGvlParameters(project) {
    const dbIr = buildDbParamsIR(project);
    if (!dbIr)
        return null;
    const r = renderDataBlockCodesys(dbIr);
    return { path: r.path, kind: 'st', content: r.content };
}
export function generateGvlRecipes(project) {
    const dbIr = buildDbRecipesIR(project);
    if (!dbIr)
        return null;
    const r = renderDataBlockCodesys(dbIr);
    return { path: r.path, kind: 'st', content: r.content };
}
export function generateGvlAlarms(project) {
    const dbIr = buildDbAlarmsIR(project);
    if (!dbIr)
        return null;
    const r = renderDataBlockCodesys(dbIr);
    return { path: r.path, kind: 'st', content: r.content };
}

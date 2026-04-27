import { buildDbRecipesIR } from '../compiler/program/data-blocks.js';
import { renderDataBlockSiemens } from '../compiler/renderers/data-blocks.js';
/** Backward-compat facade — builds IR + renders Siemens. */
export function generateDbRecipes(project) {
    const dbIr = buildDbRecipesIR(project);
    if (!dbIr)
        return null;
    const rendered = renderDataBlockSiemens(dbIr);
    return { path: rendered.path, kind: 'scl', content: rendered.content };
}

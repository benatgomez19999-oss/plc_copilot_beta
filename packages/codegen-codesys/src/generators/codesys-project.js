import { compileProject, } from '@plccopilot/codegen-core';
import { renderFunctionBlockCodesys } from '../renderers/codesys-st.js';
import { renderDataBlockCodesys } from '../renderers/data-blocks.js';
import { renderTypeArtifactCodesys } from '../renderers/types.js';
import { CODESYS_DIR } from '../naming.js';
import { generateCodesysManifest } from './codesys-manifest.js';
/**
 * EXPERIMENTAL Codesys / IEC 61131-3 Structured Text backend POC.
 *
 * Reuses the same `compileProject` → `ProgramIR` pipeline as the Siemens
 * backend. Renders FBs by walking the same `FunctionBlockIR`, with a small
 * Siemens→IEC text translation layer in `renderers/codesys-st.ts` for any
 * residual Raw IR text.
 *
 * What this POC PROVES:
 *   - station FBs render to plausible IEC 61131-3 ST.
 *   - alarm flow (FB_Alarms / GVL_Alarms) works under the same feature flags.
 *   - diagnostics from the shared ProgramIR flow into the Codesys manifest.
 *
 * What this POC EXPLICITLY DOES NOT DO:
 *   - emit a `.project` Codesys archive — these are bare `.st` text files.
 *   - declare global IO mappings (engineer wires those manually for now).
 *   - generate POU pinmap, device tree, fieldbus config or HMI assets.
 */
export function generateCodesysProject(project, options) {
    const program = compileProject(project, options);
    return renderProgramArtifactsCodesys(program);
}
/**
 * Render a previously-built ProgramIR as a Codesys artifact bundle.
 */
export function renderProgramArtifactsCodesys(program) {
    const out = [];
    // --- Function blocks: same FunctionBlockIR as Siemens ---
    for (const fb of program.blocks) {
        out.push({
            path: `${CODESYS_DIR}/${fb.name}.st`,
            kind: 'st',
            content: renderFunctionBlockCodesys(fb),
        });
    }
    // --- DUTs: same structured TypeArtifactIR, Codesys renderer ---
    for (const t of program.typeArtifacts) {
        const rendered = renderTypeArtifactCodesys(t);
        out.push({ path: rendered.path, kind: 'st', content: rendered.content });
    }
    // --- GVLs: same structured DataBlockArtifactIR, Codesys renderer ---
    for (const db of program.dataBlocks) {
        const rendered = renderDataBlockCodesys(db);
        out.push({ path: rendered.path, kind: 'st', content: rendered.content });
    }
    // --- Manifest: inherits diagnostics + features from ProgramIR ---
    const artifactPaths = out.map((a) => a.path);
    out.push(generateCodesysManifest(program, artifactPaths));
    return out;
}

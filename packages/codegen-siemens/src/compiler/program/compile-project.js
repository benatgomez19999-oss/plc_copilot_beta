import { compileProject as compileProjectCore, resolveFeatures, toArtifactDiagnostic, } from '@plccopilot/codegen-core';
import { basename, MANIFEST_PATH, SIEMENS_DIR } from '../../naming.js';
/**
 * Siemens-flavoured wrapper around the vendor-neutral `compileProject` from
 * `@plccopilot/codegen-core`. Pipeline-level work (lowering, IR building,
 * symbol resolution, diagnostics) lives in core; this wrapper overlays the
 * Siemens-canonical manifest fields so legacy consumers that read
 * `program.manifest.path` / `program.manifest.generator` /
 * `program.manifest.artifactPaths` / `program.target.vendor` keep their
 * existing observable contract.
 *
 * Backwards compatibility is the only reason this file exists. New consumers
 * should prefer `compileProject` from `@plccopilot/codegen-core` directly.
 */
const DEFAULT_TIA_VERSION = '19';
const DEFAULT_VENDOR = 'siemens_s7_1500';
const DEFAULT_GENERATOR_VERSION = '0.1.0';
const GENERATOR_NAME = '@plccopilot/codegen-siemens';
export { resolveFeatures };
export function compileProject(project, options) {
    const program = compileProjectCore(project, {
        generatedAt: options?.generatedAt ?? options?.manifest?.generatedAt ?? undefined,
        features: options?.features,
    });
    const target = {
        vendor: options?.manifest?.vendor ?? DEFAULT_VENDOR,
        tiaVersion: options?.manifest?.tiaVersion ?? DEFAULT_TIA_VERSION,
    };
    const artifactPaths = [];
    for (const fb of program.blocks)
        artifactPaths.push(basename(`${SIEMENS_DIR}/${fb.name}.scl`));
    for (const t of program.typeArtifacts)
        artifactPaths.push(`${t.name}.scl`);
    for (const db of program.dataBlocks)
        artifactPaths.push(basename(`${SIEMENS_DIR}/${db.name}.scl`));
    for (const tt of program.tagTables)
        artifactPaths.push(`${tt.name}.csv`);
    return {
        ...program,
        target,
        manifest: {
            ...program.manifest,
            path: MANIFEST_PATH,
            generator: GENERATOR_NAME,
            generatorVersion: options?.manifest?.generatorVersion ?? DEFAULT_GENERATOR_VERSION,
            target,
            artifactPaths,
            compilerDiagnostics: program.diagnostics.map(toArtifactDiagnostic),
        },
    };
}

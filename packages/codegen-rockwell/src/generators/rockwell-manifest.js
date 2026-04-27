import { basename, stableJson, } from '@plccopilot/codegen-core';
import { ROCKWELL_MANIFEST_PATH } from '../naming.js';
export { ROCKWELL_MANIFEST_PATH };
/**
 * Build the Rockwell-side manifest. Same shape as Codesys manifest plus:
 *   - backend: 'rockwell'
 *   - experimental: true
 *   - target.vendor: 'rockwell_logix5000'
 *
 * `program.manifest.compilerDiagnostics` is expected to already include the
 * Rockwell-specific diagnostics (ROCKWELL_EXPERIMENTAL_BACKEND, …) — the
 * `generateRockwellProject` entry point merges them before rendering.
 */
export function generateRockwellManifest(program, artifactPaths) {
    const data = {
        generator: '@plccopilot/codegen-rockwell',
        backend: 'rockwell',
        experimental: true,
        version: '0.1.0',
        pir_version: program.pirVersion,
        project_id: program.projectId,
        project_name: program.projectName,
        target: {
            vendor: 'rockwell_logix5000',
            studio_version: null,
        },
        features: {
            use_db_alarms: program.features.useDbAlarms,
            emit_fb_alarms: program.features.emitFbAlarms,
            emit_diagnostics_in_manifest: program.features.emitDiagnosticsInManifest,
            strict_diagnostics: program.features.strictDiagnostics,
        },
        artifacts: artifactPaths.map(basename),
        generated_at: program.manifest.generatedAt,
    };
    if (program.features.emitDiagnosticsInManifest) {
        data.compiler_diagnostics = program.manifest.compilerDiagnostics.map((d) => ({
            code: d.code,
            severity: d.severity,
            message: d.message,
            ...(d.path !== undefined ? { path: d.path } : {}),
            ...(d.stationId !== undefined ? { station_id: d.stationId } : {}),
            ...(d.symbol !== undefined ? { symbol: d.symbol } : {}),
            ...(d.hint !== undefined ? { hint: d.hint } : {}),
        }));
    }
    return {
        path: ROCKWELL_MANIFEST_PATH,
        kind: 'json',
        content: stableJson(data),
    };
}

import { codegenErrorFromDiagnostic } from '@plccopilot/codegen-core';
import { stationArtifactPath } from '../naming.js';
import { firstError, toArtifactDiagnostic, } from '../compiler/diagnostics.js';
import { lowerStation } from '../compiler/lowering/station.js';
import { renderFunctionBlock } from '../compiler/renderers/scl.js';
/**
 * Public façade — unchanged signature. Internally this delegates to the
 * compiler pipeline (symbols → AST → IR → SCL renderer). Diagnostics produced
 * during lowering are inspected; the first error is re-thrown as a
 * CodegenError to preserve the contract with existing callers and tests.
 *
 * Non-error diagnostics (info/warning) are attached to the returned artifact
 * under `.diagnostics`, mapped to the flat `ArtifactDiagnostic` shape.
 */
export function generateStationFb(machine, station) {
    const { fb, diagnostics } = lowerStation(machine, station);
    const err = firstError(diagnostics);
    if (err) {
        // Sprint 40 — preserve every structured field the lowering layer
        // populated (`stationId`, `symbol`, `hint`) instead of dropping
        // all but `path`.
        throw codegenErrorFromDiagnostic(err);
    }
    const artifactDiags = diagnostics.map(toArtifactDiagnostic);
    const artifact = {
        path: stationArtifactPath(station),
        kind: 'scl',
        content: renderFunctionBlock(fb),
    };
    if (artifactDiags.length > 0)
        artifact.diagnostics = artifactDiags;
    return artifact;
}

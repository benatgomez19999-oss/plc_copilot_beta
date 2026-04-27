/**
 * Produce a stable, deterministic JSON string that summarises a ProgramIR
 * for caching / debugging / cross-process exchange.
 *
 * Design goals:
 *   - Same ProgramIR → identical string (byte-for-byte).
 *   - No functions, no undefined, no Symbols (nullable fields use `null`).
 *   - Metadata only — block/DB/tag content is NOT included. The payload
 *     stays cheap and stable even when IR content shifts byte-for-byte.
 *   - Backend-specific fields (manifest paths, tag formats, target vendor)
 *     are omitted from the canonical IR shape; backends serialize their
 *     own augmentations if needed.
 */
export function serializeProgramIR(program) {
    return JSON.stringify(toSerializable(program), null, 2) + '\n';
}
function toSerializable(program) {
    return {
        project: {
            id: program.projectId,
            name: program.projectName,
            pirVersion: program.pirVersion,
        },
        target: {
            vendor: program.target?.vendor ?? null,
            tiaVersion: program.target?.tiaVersion ?? null,
        },
        features: {
            useDbAlarms: program.features.useDbAlarms,
            emitFbAlarms: program.features.emitFbAlarms,
            emitDiagnosticsInManifest: program.features.emitDiagnosticsInManifest,
            strictDiagnostics: program.features.strictDiagnostics,
        },
        blocks: program.blocks.map((b) => ({
            name: b.name,
            stationId: b.stationId ?? null,
        })),
        typeArtifacts: program.typeArtifacts.map((t) => ({
            name: t.name,
            typeKind: t.typeKind,
            fieldCount: t.fields.length,
        })),
        dataBlocks: program.dataBlocks.map((d) => ({
            name: d.name,
            dbKind: d.dbKind,
            fieldCount: d.fields.length,
        })),
        tagTables: program.tagTables.map((t) => ({
            name: t.name,
            kind: t.kind,
            rowCount: t.rows.length,
        })),
        manifest: {
            generatedAt: program.manifest.generatedAt,
            diagnosticCount: program.manifest.compilerDiagnostics.length,
        },
        diagnostics: program.diagnostics.map((d) => {
            const out = {
                code: d.code,
                severity: d.severity,
                message: d.message,
            };
            if (d.path !== undefined)
                out.path = d.path;
            if (d.stationId !== undefined)
                out.stationId = d.stationId;
            if (d.symbol !== undefined)
                out.symbol = d.symbol;
            if (d.hint !== undefined)
                out.hint = d.hint;
            return out;
        }),
    };
}

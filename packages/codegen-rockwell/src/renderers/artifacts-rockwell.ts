import {
  dedupDiagnostics,
  diag,
  sortDiagnostics,
  toArtifactDiagnostic,
  type ArtifactDiagnostic,
  type Diagnostic,
  type FunctionBlockIR,
  type GeneratedArtifact,
  type ProgramIR,
} from '@plccopilot/codegen-core';
import { renderFunctionBlockRockwell } from './rockwell-st.js';
import { renderTypeArtifactRockwell } from './types.js';
import { generateRockwellTagFiles } from '../generators/rockwell-tags.js';
import { generateRockwellManifest } from '../generators/rockwell-manifest.js';
import { ROCKWELL_DIR } from '../naming.js';

/**
 * Compute the Rockwell-specific compile-time diagnostics that surface POC
 * limitations. Pure: takes a ProgramIR, returns extra Diagnostic[].
 *
 *   ROCKWELL_EXPERIMENTAL_BACKEND  always (info)
 *   ROCKWELL_NO_L5X_EXPORT         always (info)
 *   ROCKWELL_TIMER_PSEUDO_IEC      when at least one TON-typed VarDecl exists
 */
export function computeRockwellDiagnostics(program: ProgramIR): Diagnostic[] {
  const out: Diagnostic[] = [];
  out.push(
    diag(
      'info',
      'ROCKWELL_EXPERIMENTAL_BACKEND',
      'Rockwell ST POC backend: textual artifacts only, not directly importable to Studio 5000',
      {
        hint: 'use the Siemens or Codesys backends for production output until the L5X exporter ships',
      },
    ),
  );
  out.push(
    diag(
      'info',
      'ROCKWELL_NO_L5X_EXPORT',
      'Rockwell backend does not emit a Studio 5000 L5X archive — only `.st` text files',
      {
        hint: 'a future sprint will add an L5X writer with controller / program / routine wrapping',
      },
    ),
  );
  if (hasTimers(program)) {
    out.push(
      diag(
        'warning',
        'ROCKWELL_TIMER_PSEUDO_IEC',
        'IEC TON instances are rendered with `.Q` semantics; Studio 5000 needs Logix TIMER tags with `.DN` / `.ACC`',
        {
          hint: 'a future L5X backend will rewrite TonCall → Logix TIMER instructions',
        },
      ),
    );
  }
  return out;
}

function hasTimers(program: ProgramIR): boolean {
  for (const fb of program.blocks) {
    for (const sec of fb.varSections) {
      for (const d of sec.decls) {
        if (d.type === 'TON') return true;
      }
    }
  }
  return false;
}

/**
 * Layer Rockwell-specific diagnostics on top of a ProgramIR. Idempotent
 * (dedup catches re-application). Returns a new ProgramIR; the input is
 * not mutated.
 */
export function withRockwellDiagnostics(program: ProgramIR): ProgramIR {
  const merged = sortDiagnostics(
    dedupDiagnostics([
      ...program.diagnostics,
      ...computeRockwellDiagnostics(program),
    ]),
  );
  return {
    ...program,
    diagnostics: merged,
    manifest: {
      ...program.manifest,
      compilerDiagnostics: merged.map(toArtifactDiagnostic),
    },
  };
}

/**
 * Emit every Rockwell artifact described by the (Rockwell-augmented)
 * ProgramIR, in the canonical order:
 *
 *   1. Station FBs (blocks) → `rockwell/<name>.st`
 *   2. UDTs (typeArtifacts) → `rockwell/<name>.st`
 *   3. Tag files (params/recipes/alarms) → `rockwell/TAG_<X>.st`
 *   4. manifest.json
 *
 * Station FB artifacts receive the subset of diagnostics that carry their
 * stationId. The manifest receives every diagnostic via `compiler_diagnostics`.
 *
 * If callers pass a raw ProgramIR (not augmented), `withRockwellDiagnostics`
 * is applied here so both code paths agree on the surfaced diagnostics.
 */
export function renderProgramArtifactsRockwell(
  program: ProgramIR,
): GeneratedArtifact[] {
  const augmented = withRockwellDiagnostics(program);
  const out: GeneratedArtifact[] = [];

  for (const fb of augmented.blocks) {
    out.push(renderBlockArtifact(fb, augmented));
  }

  for (const t of augmented.typeArtifacts) {
    const rendered = renderTypeArtifactRockwell(t);
    out.push({ path: rendered.path, kind: 'st', content: rendered.content });
  }

  for (const tag of generateRockwellTagFiles(augmented.dataBlocks)) {
    out.push(tag);
  }

  const artifactPaths = out.map((a) => a.path);
  out.push(generateRockwellManifest(augmented, artifactPaths));

  return out;
}

function renderBlockArtifact(
  fb: FunctionBlockIR,
  program: ProgramIR,
): GeneratedArtifact {
  const path = `${ROCKWELL_DIR}/${fb.name}.st`;
  const content = renderFunctionBlockRockwell(fb);

  const stationDiags: ArtifactDiagnostic[] = fb.stationId
    ? program.diagnostics
        .filter((d) => d.stationId === fb.stationId)
        .map(toArtifactDiagnostic)
    : [];

  const artifact: GeneratedArtifact = { path, kind: 'st', content };
  if (stationDiags.length > 0) artifact.diagnostics = stationDiags;
  return artifact;
}

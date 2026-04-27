import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '../types.js';
import { MANIFEST_PATH, basename } from '../naming.js';
import { stableJson } from '../utils/json.js';

export interface ManifestOptions {
  generatedAt?: string;
  tiaVersion?: string;
  vendor?: string;
  generatorVersion?: string;
}

const DEFAULT_GENERATED_AT = '1970-01-01T00:00:00Z';
const DEFAULT_TIA_VERSION = '19';
const DEFAULT_VENDOR = 'siemens_s7_1500';
const DEFAULT_GENERATOR_VERSION = '0.1.0';

export function generateManifest(
  project: Project,
  otherArtifacts: readonly GeneratedArtifact[],
  opts?: ManifestOptions,
): GeneratedArtifact {
  const artifacts = otherArtifacts.map((a) => basename(a.path));

  const data = {
    generator: '@plccopilot/codegen-siemens',
    version: opts?.generatorVersion ?? DEFAULT_GENERATOR_VERSION,
    pir_version: project.pir_version,
    project_id: project.id,
    project_name: project.name,
    target: {
      vendor: opts?.vendor ?? DEFAULT_VENDOR,
      tia_version: opts?.tiaVersion ?? DEFAULT_TIA_VERSION,
    },
    artifacts,
    generated_at: opts?.generatedAt ?? DEFAULT_GENERATED_AT,
  };

  return {
    path: MANIFEST_PATH,
    kind: 'json',
    content: stableJson(data),
  };
}

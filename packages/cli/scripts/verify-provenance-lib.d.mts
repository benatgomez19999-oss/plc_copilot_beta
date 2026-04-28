// Sprint 65 + 70 — type declarations for the provenance helper lib.

export const PROVENANCE_DEFAULT_REGISTRY: string;
export const PROVENANCE_PACKAGE_ORDER: readonly string[];
export const PROVENANCE_EXPECTED_REPO_URL: string;
export const PROVENANCE_EXPECTED_WORKFLOW_PATH: string;
export const PROVENANCE_EXPECTED_PREDICATE_TYPE: string;
export const PROVENANCE_MODES: readonly ['default', 'config-only', 'metadata-only'];

export type ProvenanceLevel = 'error' | 'warning' | 'info';

export interface ProvenanceIssue {
  level: ProvenanceLevel;
  code: string;
  message: string;
  recommendation: string | null;
}

export interface ProvenanceOptions {
  version: string | null;
  registry: string | null;
  configOnly: boolean;
  metadataOnly: boolean;
  json: boolean;
  help: boolean;
}

export function parseProvenanceArgs(argv: readonly string[] | unknown): {
  options: ProvenanceOptions | null;
  errors: ProvenanceIssue[];
};

export function resolveProvenanceMode(
  options: Partial<ProvenanceOptions> | null | undefined,
): 'default' | 'config-only' | 'metadata-only';

// ---------------------------------------------------------------------------
// Sprint 65 stub helpers
// ---------------------------------------------------------------------------

export function checkPublishWorkflowProvenance(input: {
  workflowText: string;
}): ProvenanceIssue[];

export function checkPublishCommandProvenance(input?: {
  tags?: readonly string[];
}): ProvenanceIssue[];

export interface ProvenanceStubReport {
  ok: boolean;
  version: string | null;
  checks: {
    workflow_id_token_write: boolean;
    workflow_provenance_flag: boolean;
    command_provenance_flag: boolean;
    command_no_dry_run: boolean;
  };
  note: string;
  issues: ProvenanceIssue[];
}

export function buildProvenanceStubReport(input: {
  version: string | null;
  workflowIssues: ProvenanceIssue[];
  commandIssues: ProvenanceIssue[];
}): ProvenanceStubReport;

// ---------------------------------------------------------------------------
// Sprint 70 — registry-metadata + attestation-claims helpers
// ---------------------------------------------------------------------------

export function buildNpmViewPackageArgs(input: {
  packageName: string;
  version: string;
  registry: string;
}): readonly string[];

export function assertNoNpmMutationSurfaceProvenance(
  argv: readonly string[] | unknown,
): true;

export function parseNpmViewJson(stdout: string | null | undefined): unknown;

export function normalizeRepositoryUrl(url: unknown): string | null;

export interface MetadataExpected {
  packageName: string;
  version: string;
  repositoryUrl?: string;
}

export function validatePackageMetadataProvenance(
  metadata: unknown,
  expected: MetadataExpected,
): ProvenanceIssue[];

export interface AttestationsBundleSplit {
  slsa: unknown;
  npm: unknown;
  issues: ProvenanceIssue[];
}

export function extractAttestationsBundle(
  rawJson: unknown,
): AttestationsBundleSplit;

export function decodeDsseProvenancePayload(
  bundleEntry: unknown,
): { statement: unknown; issues: ProvenanceIssue[] };

export interface AttestationClaimsExpected {
  packageName: string;
  version: string;
  repositoryUrl?: string;
  workflowPath?: string;
}

export function validateAttestationClaims(
  statement: unknown,
  expected: AttestationClaimsExpected,
): ProvenanceIssue[];

export function extractAttestationGitCommit(statement: unknown): string | null;

// ---------------------------------------------------------------------------
// Sprint 70 — full report
// ---------------------------------------------------------------------------

export interface ProvenancePackageResult {
  name: string;
  version: string;
  distIntegrity: boolean;
  tarball: boolean;
  attestations: {
    present: boolean;
    url?: string | null;
    predicateType?: string | null;
    workflowPath?: string | null;
    repositoryUrl?: string | null;
    gitCommit?: string | null;
    claimsVerified?: boolean;
  } | null;
  issues: ProvenanceIssue[];
}

export interface ProvenanceConfigChecks {
  workflow_id_token_write: boolean;
  publish_command_provenance_flag: boolean;
  publish_command_no_dry_run: boolean;
  issues: ProvenanceIssue[];
}

export interface ProvenanceReport {
  ok: boolean;
  version: string | null;
  registry: string | null;
  mode: 'default' | 'config-only' | 'metadata-only';
  config: {
    workflow_id_token_write: boolean;
    publish_command_provenance_flag: boolean;
    publish_command_no_dry_run: boolean;
  } | null;
  packages: Array<{
    name: string | null;
    version: string | null;
    repository_ok: boolean;
    dist_integrity: boolean;
    tarball: boolean;
    attestations: {
      present: boolean;
      url?: string | null;
      predicate_type?: string | null;
      workflow_path?: string | null;
      repository_url?: string | null;
      git_commit?: string | null;
      claims_verified: boolean;
      cryptographically_verified: false;
    };
    issues: ProvenanceIssue[];
  }> | null;
  cryptographic_verification: {
    implemented: false;
    verified: false;
    note: string;
  };
  note: string;
  issues: ProvenanceIssue[];
}

export function buildProvenanceReport(input: {
  mode: 'default' | 'config-only' | 'metadata-only';
  version: string | null;
  registry: string | null;
  configChecks?: ProvenanceConfigChecks | null;
  packageResults?: ProvenancePackageResult[] | null;
  cryptoVerified?: boolean;
}): ProvenanceReport;

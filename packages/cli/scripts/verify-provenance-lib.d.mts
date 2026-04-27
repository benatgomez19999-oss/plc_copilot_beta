// Sprint 65 — type declarations for the provenance stub helper lib.

export interface ProvenanceIssue {
  level: 'error';
  code: string;
  message: string;
  recommendation: string | null;
}

export interface ProvenanceOptions {
  version: string | null;
  json: boolean;
  help: boolean;
}

export function parseProvenanceArgs(argv: readonly string[] | unknown): {
  options: ProvenanceOptions | null;
  errors: ProvenanceIssue[];
};

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

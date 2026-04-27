// Sprint 56 — minimal type surface for ../scripts/publish-audit-lib.mjs.
//
// The lib itself is a Node-builtins-only `.mjs` so the runner can load
// without any build step. Vitest's transform happily imports it from
// the `.ts` spec, but `tsc --noEmit` (the CLI's strict typecheck) needs
// declarations alongside the JS module — hence this `.d.mts`. Types
// are intentionally loose (`unknown` / `string` / `Record`) since the
// audit's contract is verified by tests, not by inference.

export type FindingLevel = 'blocker' | 'warning' | 'info';

export interface AuditFinding {
  level: FindingLevel;
  code: string;
  message: string;
  recommendation: string | null;
}

export interface WorkspaceDependency {
  name: string;
  range: string;
  section: string;
  isWorkspaceProtocol: boolean;
}

export type PublishIntent = 'publishable' | 'internal' | 'app';

export interface PackageInfo {
  dir: string;
  packageDir: string;
  pkg: Record<string, unknown>;
  hasSrcIndex: boolean;
  hasDistIndex: boolean;
  hasDistTypes: boolean;
  hasTsconfigBuild: boolean;
  hasTsconfig: boolean;
  hasViteConfig: boolean;
  hasVitestConfig: boolean;
  hasSchemasDir: boolean;
  distExists: boolean;
}

export interface PackageAnalysis {
  info: PackageInfo;
  intent: PublishIntent;
  internalDeps: string[];
  findings: AuditFinding[];
}

export interface AuditSummary {
  package_count: number;
  publishable_candidates: number;
  internal: number;
  apps: number;
  blockers: number;
  warnings: number;
  infos: number;
}

export interface WorkspaceAudit {
  repoRoot: string;
  packagesRoot: string;
  packages: PackageAnalysis[];
  graph: Map<string, string[]>;
  publishBuildOrder: string[];
  cycle: string[] | null;
  summary: AuditSummary;
}

export interface JsonReport {
  generated_at: string;
  package_count: number;
  summary: AuditSummary;
  build_order: string[];
  cycle: string[] | null;
  packages: Array<Record<string, unknown>>;
}

export const FINDING_LEVELS: ReadonlyArray<FindingLevel>;
export const FINDING_CODES: Readonly<Record<string, string>>;

export function classifyPublishIntent(
  pkg: Record<string, unknown>,
  dirName: string,
): PublishIntent;

export function collectWorkspaceDependencies(
  pkg: Record<string, unknown>,
): WorkspaceDependency[];

export function readPackageInfo(packageDir: string): PackageInfo;

export function discoverPackages(packagesRoot: string): string[];

export function analyzePackage(info: PackageInfo): {
  intent: PublishIntent;
  internalDeps: string[];
  findings: AuditFinding[];
};

export function buildDependencyGraph(
  packages: ReadonlyArray<{ pkg: Record<string, unknown> }>,
): Map<string, string[]>;

export function topoSort(
  graph: Map<string, string[]>,
  names: ReadonlyArray<string>,
): { order: string[]; cycle?: undefined } | { cycle: string[]; order?: undefined };

export function auditWorkspace(repoRoot: string): WorkspaceAudit;

export function renderMarkdownReport(audit: WorkspaceAudit): string;

export function buildJsonReport(
  audit: WorkspaceAudit,
  generatedAt?: string,
): JsonReport;

// Sprint 65 + 70 — pure tests for the provenance helper lib + the
// post-publish-verify.yml + verify-provenance.yml workflow assertions.
//
// (Single-line comments — JSDoc blocks would close on `*/` inside an
// `@plccopilot/...` package path.)

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVENANCE_DEFAULT_REGISTRY,
  PROVENANCE_EXPECTED_PREDICATE_TYPE,
  PROVENANCE_EXPECTED_REPO_URL,
  PROVENANCE_EXPECTED_WORKFLOW_PATH,
  PROVENANCE_MODES,
  PROVENANCE_PACKAGE_ORDER,
  assertNoNpmMutationSurfaceProvenance,
  buildNpmViewPackageArgs,
  buildProvenanceReport,
  buildProvenanceStubReport,
  checkPublishCommandProvenance,
  checkPublishWorkflowProvenance,
  decodeDsseProvenancePayload,
  extractAttestationGitCommit,
  extractAttestationsBundle,
  normalizeRepositoryUrl,
  parseNpmViewJson,
  parseProvenanceArgs,
  resolveProvenanceMode,
  validateAttestationClaims,
  validatePackageMetadataProvenance,
} from '../scripts/verify-provenance-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const PUBLISH_WORKFLOW_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'publish.yml');
const POST_PUBLISH_PATH = resolve(REPO_ROOT, '.github', 'workflows', 'post-publish-verify.yml');
const VERIFY_PROVENANCE_PATH = resolve(
  REPO_ROOT,
  '.github',
  'workflows',
  'verify-provenance.yml',
);

const OK_WORKFLOW = `
name: Publish packages
permissions:
  contents: read
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    steps:
      - run: pnpm release:publish-real --version 0.1.0 --tag next --confirm "..."
        # invokes npm publish --provenance --access public --tag next
`;

// =============================================================================
// constants
// =============================================================================

describe('provenance constants', () => {
  it('default registry is npmjs', () => {
    expect(PROVENANCE_DEFAULT_REGISTRY).toBe('https://registry.npmjs.org');
  });

  it('package order matches the publish order', () => {
    expect(PROVENANCE_PACKAGE_ORDER).toContain('@plccopilot/cli');
    expect(PROVENANCE_PACKAGE_ORDER.length).toBe(6);
  });

  it('expected repo + workflow path are recorded', () => {
    expect(PROVENANCE_EXPECTED_REPO_URL).toBe(
      'https://github.com/benatgomez19999-oss/plc_copilot_beta',
    );
    expect(PROVENANCE_EXPECTED_WORKFLOW_PATH).toBe('.github/workflows/publish.yml');
    expect(PROVENANCE_EXPECTED_PREDICATE_TYPE).toBe('https://slsa.dev/provenance/v1');
  });

  it('modes are exactly default | config-only | metadata-only', () => {
    expect([...PROVENANCE_MODES]).toEqual(['default', 'config-only', 'metadata-only']);
  });
});

// =============================================================================
// parseProvenanceArgs
// =============================================================================

describe('parseProvenanceArgs', () => {
  it('returns the option bag for empty argv', () => {
    const { options, errors } = parseProvenanceArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      version: null,
      registry: null,
      configOnly: false,
      metadataOnly: false,
      json: false,
      help: false,
    });
  });

  it('parses --version (space + equals form), --registry, --json, --help', () => {
    expect(
      parseProvenanceArgs(['--version', '0.1.0', '--json']).options,
    ).toMatchObject({ version: '0.1.0', json: true });
    expect(parseProvenanceArgs(['--version=0.1.0']).options?.version).toBe('0.1.0');
    expect(parseProvenanceArgs(['--registry=https://r.example']).options?.registry).toBe(
      'https://r.example',
    );
    expect(parseProvenanceArgs(['-h']).options?.help).toBe(true);
  });

  it('parses --config-only and --metadata-only', () => {
    expect(parseProvenanceArgs(['--config-only']).options?.configOnly).toBe(true);
    expect(parseProvenanceArgs(['--metadata-only']).options?.metadataOnly).toBe(true);
  });

  it('flags --config-only + --metadata-only as mutually exclusive', () => {
    const { errors } = parseProvenanceArgs(['--config-only', '--metadata-only']);
    expect(errors.map((e) => e.code)).toContain('PROVENANCE_UNKNOWN_FLAG');
  });

  it('emits PROVENANCE_FLAG_MISSING_VALUE for --version with no value', () => {
    const { errors } = parseProvenanceArgs(['--version']);
    expect(errors.map((e) => e.code)).toContain('PROVENANCE_FLAG_MISSING_VALUE');
  });

  it('emits PROVENANCE_UNKNOWN_FLAG / PROVENANCE_ARGV_INVALID', () => {
    expect(parseProvenanceArgs(['--banana']).errors.map((e) => e.code)).toContain(
      'PROVENANCE_UNKNOWN_FLAG',
    );
    expect(parseProvenanceArgs('nope' as any).errors.map((e) => e.code)).toContain(
      'PROVENANCE_ARGV_INVALID',
    );
  });

  it('rejects npm-mutation flags at parse time', () => {
    for (const flag of ['--publish', '--no-dry-run', '--dry-run', '--dist-tag', '--yes', '-y']) {
      const codes = parseProvenanceArgs([flag]).errors.map((e) => e.code);
      expect(codes).toContain('PROVENANCE_UNKNOWN_FLAG');
    }
  });
});

// =============================================================================
// resolveProvenanceMode
// =============================================================================

describe('resolveProvenanceMode', () => {
  it('returns default when neither flag is set', () => {
    expect(resolveProvenanceMode({ configOnly: false, metadataOnly: false })).toBe('default');
  });

  it('returns config-only when --config-only', () => {
    expect(resolveProvenanceMode({ configOnly: true, metadataOnly: false })).toBe('config-only');
  });

  it('returns metadata-only when --metadata-only', () => {
    expect(resolveProvenanceMode({ configOnly: false, metadataOnly: true })).toBe('metadata-only');
  });

  it('returns default for null / undefined', () => {
    expect(resolveProvenanceMode(null)).toBe('default');
    expect(resolveProvenanceMode(undefined)).toBe('default');
  });
});

// =============================================================================
// Sprint 65 stub helpers — kept (back-compat assertions)
// =============================================================================

describe('checkPublishWorkflowProvenance', () => {
  it('passes the canonical workflow snippet', () => {
    expect(checkPublishWorkflowProvenance({ workflowText: OK_WORKFLOW })).toEqual([]);
  });

  it('passes the actual repo workflow', () => {
    const text = readFileSync(PUBLISH_WORKFLOW_PATH, 'utf-8');
    expect(checkPublishWorkflowProvenance({ workflowText: text })).toEqual([]);
  });

  it('emits PROVENANCE_WORKFLOW_NO_ID_TOKEN when missing', () => {
    const text = OK_WORKFLOW.replace(/id-token:\s*write/, 'id-token: read');
    const codes = checkPublishWorkflowProvenance({ workflowText: text }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_WORKFLOW_NO_ID_TOKEN');
  });

  it('emits PROVENANCE_WORKFLOW_NO_PROVENANCE_FLAG when missing', () => {
    const text = OK_WORKFLOW.replace('--provenance', '--ignore-this');
    const codes = checkPublishWorkflowProvenance({ workflowText: text }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_WORKFLOW_NO_PROVENANCE_FLAG');
  });

  it('emits PROVENANCE_WORKFLOW_MISSING for empty input', () => {
    const codes = checkPublishWorkflowProvenance({ workflowText: '' }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_WORKFLOW_MISSING');
  });
});

describe('checkPublishCommandProvenance', () => {
  it('passes when the live release-publish-real argv has --provenance for every tag', () => {
    expect(checkPublishCommandProvenance()).toEqual([]);
  });

  it('rejects an empty tag list', () => {
    const codes = checkPublishCommandProvenance({ tags: [] }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_COMMAND_NO_TAGS');
  });

  it('rejects an unknown tag with PROVENANCE_COMMAND_BUILDER_THREW', () => {
    const codes = checkPublishCommandProvenance({ tags: ['experimental'] }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_COMMAND_BUILDER_THREW');
  });
});

describe('buildProvenanceStubReport', () => {
  it('marks ok=true when both lists are empty', () => {
    const r = buildProvenanceStubReport({ version: '0.1.0', workflowIssues: [], commandIssues: [] });
    expect(r.ok).toBe(true);
    expect(r.checks.workflow_id_token_write).toBe(true);
    expect(r.checks.command_no_dry_run).toBe(true);
  });

  it('flips a specific check to false when its issue is present', () => {
    const r = buildProvenanceStubReport({
      version: '0.1.0',
      workflowIssues: [
        {
          level: 'error',
          code: 'PROVENANCE_WORKFLOW_NO_ID_TOKEN',
          message: 'x',
          recommendation: null,
        },
      ],
      commandIssues: [],
    });
    expect(r.ok).toBe(false);
    expect(r.checks.workflow_id_token_write).toBe(false);
    expect(r.checks.workflow_provenance_flag).toBe(true);
  });

  it('always carries the stub note', () => {
    const r = buildProvenanceStubReport({
      version: null,
      workflowIssues: [],
      commandIssues: [],
    });
    expect(r.note.toLowerCase()).toContain('stub');
  });
});

// =============================================================================
// buildNpmViewPackageArgs
// =============================================================================

describe('buildNpmViewPackageArgs', () => {
  const ok = {
    packageName: '@plccopilot/cli',
    version: '0.1.0',
    registry: 'https://registry.npmjs.org',
  };

  it('emits the canonical view argv', () => {
    expect([...buildNpmViewPackageArgs(ok)]).toEqual([
      'view',
      '@plccopilot/cli@0.1.0',
      '--json',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(buildNpmViewPackageArgs(ok))).toBe(true);
  });

  it('rejects out-of-scope package, bad version, bad registry', () => {
    expect(() => buildNpmViewPackageArgs({ ...ok, packageName: 'left-pad' })).toThrow();
    expect(() => buildNpmViewPackageArgs({ ...ok, version: '0.1' })).toThrow();
    expect(() => buildNpmViewPackageArgs({ ...ok, registry: 'file:./x' })).toThrow();
  });

  it('never contains publish or dist-tag tokens', () => {
    const args = buildNpmViewPackageArgs(ok);
    for (const banned of ['publish', '--publish', 'dist-tag', '--no-dry-run']) {
      expect([...args]).not.toContain(banned);
    }
  });
});

// =============================================================================
// assertNoNpmMutationSurfaceProvenance
// =============================================================================

describe('assertNoNpmMutationSurfaceProvenance', () => {
  it('passes a clean view argv', () => {
    expect(
      assertNoNpmMutationSurfaceProvenance([
        'view',
        '@plccopilot/cli@0.1.0',
        '--json',
        '--registry',
        'https://registry.npmjs.org',
      ]),
    ).toBe(true);
  });

  it('throws on mutation tokens', () => {
    for (const t of ['publish', '--publish', '--no-dry-run', 'dist-tag']) {
      expect(() => assertNoNpmMutationSurfaceProvenance([t])).toThrow(/mutation surface/);
    }
  });

  it('throws on non-array / non-string', () => {
    expect(() => assertNoNpmMutationSurfaceProvenance('nope' as any)).toThrow();
    expect(() => assertNoNpmMutationSurfaceProvenance([42 as any])).toThrow();
  });
});

// =============================================================================
// parseNpmViewJson
// =============================================================================

describe('parseNpmViewJson', () => {
  it('parses a JSON object', () => {
    expect((parseNpmViewJson('{"name":"x","version":"0.1.0"}') as any).name).toBe('x');
  });

  it('tolerates leading npm warn lines', () => {
    expect((parseNpmViewJson('npm warn old\n{"name":"x"}') as any).name).toBe('x');
  });

  it('returns null on garbage', () => {
    expect(parseNpmViewJson('')).toBeNull();
    expect(parseNpmViewJson(undefined as any)).toBeNull();
    expect(parseNpmViewJson('not json')).toBeNull();
  });
});

// =============================================================================
// normalizeRepositoryUrl
// =============================================================================

describe('normalizeRepositoryUrl', () => {
  const expected = PROVENANCE_EXPECTED_REPO_URL;

  it('strips git+ prefix and .git suffix', () => {
    expect(
      normalizeRepositoryUrl(`git+${expected}.git`),
    ).toBe(expected);
  });

  it('strips trailing slash', () => {
    expect(normalizeRepositoryUrl(`${expected}/`)).toBe(expected);
  });

  it('keeps a clean https URL untouched', () => {
    expect(normalizeRepositoryUrl(expected)).toBe(expected);
  });

  it('handles ssh form git@github.com:owner/repo.git', () => {
    expect(
      normalizeRepositoryUrl('git@github.com:benatgomez19999-oss/plc_copilot_beta.git'),
    ).toBe(expected);
  });

  it('returns null for empty / non-string input', () => {
    expect(normalizeRepositoryUrl('')).toBeNull();
    expect(normalizeRepositoryUrl(undefined as any)).toBeNull();
    expect(normalizeRepositoryUrl(null as any)).toBeNull();
  });

  it('mismatch is detectable by string compare', () => {
    expect(normalizeRepositoryUrl('https://github.com/other/repo.git')).not.toBe(expected);
  });
});

// =============================================================================
// validatePackageMetadataProvenance
// =============================================================================

describe('validatePackageMetadataProvenance', () => {
  function cleanMetadata(name = '@plccopilot/cli', version = '0.1.0', dir = 'cli') {
    return {
      name,
      version,
      dist: {
        integrity: 'sha512-abc',
        tarball: `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`,
        attestations: {
          url: `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace('/', '%2f')}@${version}`,
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        },
      },
      repository: {
        type: 'git',
        url: `git+${PROVENANCE_EXPECTED_REPO_URL}.git`,
        directory: `packages/${dir}`,
      },
      gitHead: 'ca53b5a14df53a0d40570a1dfde3ffa0e8325bdc',
    };
  }

  it('passes a clean metadata object', () => {
    const issues = validatePackageMetadataProvenance(cleanMetadata(), {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('emits PROVENANCE_PACKAGE_NOT_FOUND on null', () => {
    const codes = validatePackageMetadataProvenance(null, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_PACKAGE_NOT_FOUND');
  });

  it('emits PROVENANCE_NAME_MISMATCH', () => {
    const m = cleanMetadata('@plccopilot/cli');
    m.name = '@plccopilot/wrong';
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_NAME_MISMATCH');
  });

  it('emits PROVENANCE_VERSION_MISMATCH', () => {
    const m = cleanMetadata();
    m.version = '0.0.9';
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_VERSION_MISMATCH');
  });

  it('emits PROVENANCE_DIST_MISSING', () => {
    const m = cleanMetadata() as any;
    delete m.dist;
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_DIST_MISSING');
  });

  it('emits PROVENANCE_INTEGRITY_MISSING / PROVENANCE_TARBALL_MISSING', () => {
    const m = cleanMetadata() as any;
    m.dist.integrity = '';
    m.dist.tarball = 'not-a-url';
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_INTEGRITY_MISSING');
    expect(codes).toContain('PROVENANCE_TARBALL_MISSING');
  });

  it('emits PROVENANCE_ATTESTATION_MISSING when dist.attestations absent', () => {
    const m = cleanMetadata() as any;
    delete m.dist.attestations;
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_ATTESTATION_MISSING');
  });

  it('emits PROVENANCE_REPOSITORY_URL_MISMATCH on wrong repo', () => {
    const m = cleanMetadata() as any;
    m.repository.url = 'git+https://github.com/other/repo.git';
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_REPOSITORY_URL_MISMATCH');
  });

  it('emits PROVENANCE_REPOSITORY_DIRECTORY_MISMATCH on wrong directory', () => {
    const m = cleanMetadata('@plccopilot/cli', '0.1.0', 'cli');
    m.repository.directory = 'packages/wrong';
    const codes = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_REPOSITORY_DIRECTORY_MISMATCH');
  });

  it('emits PROVENANCE_GIT_HEAD_MISSING as a warning, not error, when absent', () => {
    const m = cleanMetadata() as any;
    delete m.gitHead;
    const issues = validatePackageMetadataProvenance(m, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    });
    const gitHeadIssue = issues.find((i) => i.code === 'PROVENANCE_GIT_HEAD_MISSING');
    expect(gitHeadIssue).toBeDefined();
    expect(gitHeadIssue?.level).toBe('warning');
  });
});

// =============================================================================
// extractAttestationsBundle
// =============================================================================

describe('extractAttestationsBundle', () => {
  function bundleResponse(predicateTypes: string[]) {
    return {
      attestations: predicateTypes.map((pt) => ({
        predicateType: pt,
        bundle: { dsseEnvelope: { payload: 'x' } },
      })),
    };
  }

  it('finds the slsa.dev/provenance entry', () => {
    const split = extractAttestationsBundle(
      bundleResponse([
        'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
        'https://slsa.dev/provenance/v1',
      ]),
    );
    expect(split.slsa).not.toBeNull();
    expect(split.npm).not.toBeNull();
    expect(split.issues).toEqual([]);
  });

  it('reports PROVENANCE_ATTESTATION_PARSE_FAILED when slsa missing', () => {
    const split = extractAttestationsBundle(
      bundleResponse(['https://github.com/npm/attestation/tree/main/specs/publish/v0.1']),
    );
    expect(split.slsa).toBeNull();
    expect(split.issues.map((i) => i.code)).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
  });

  it('reports parse-failed on null / non-object / missing array', () => {
    expect(
      extractAttestationsBundle(null).issues.map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
    expect(
      extractAttestationsBundle({}).issues.map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
    expect(
      extractAttestationsBundle({ attestations: 'nope' }).issues.map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
  });
});

// =============================================================================
// decodeDsseProvenancePayload
// =============================================================================

describe('decodeDsseProvenancePayload', () => {
  function makeBundle(payloadObj: object) {
    const payload = Buffer.from(JSON.stringify(payloadObj), 'utf-8').toString('base64');
    return { bundle: { dsseEnvelope: { payload } } };
  }

  it('decodes a valid DSSE payload', () => {
    const stmt = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'pkg:npm/%40plccopilot%2Fcli@0.1.0' }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {},
    };
    const { statement, issues } = decodeDsseProvenancePayload(makeBundle(stmt));
    expect(issues).toEqual([]);
    expect((statement as any).predicateType).toBe('https://slsa.dev/provenance/v1');
  });

  it('reports parse-failed when payload missing', () => {
    expect(
      decodeDsseProvenancePayload({ bundle: { dsseEnvelope: {} } }).issues.map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
    expect(
      decodeDsseProvenancePayload({ bundle: {} }).issues.map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
    expect(
      decodeDsseProvenancePayload(null).issues.map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
  });

  it('reports parse-failed on non-base64-decodable / non-JSON payload', () => {
    const corrupt = {
      bundle: {
        dsseEnvelope: { payload: Buffer.from('not json', 'utf-8').toString('base64') },
      },
    };
    expect(decodeDsseProvenancePayload(corrupt).issues.map((i) => i.code)).toContain(
      'PROVENANCE_ATTESTATION_PARSE_FAILED',
    );
  });
});

// =============================================================================
// validateAttestationClaims
// =============================================================================

describe('validateAttestationClaims', () => {
  function cleanStatement(packageName = '@plccopilot/cli', version = '0.1.0') {
    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: `pkg:npm/${encodeURIComponent(packageName).replace(/%2F/g, '/')}@${version}`,
          digest: { sha512: '...' },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
          externalParameters: {
            workflow: {
              ref: 'refs/heads/main',
              repository: PROVENANCE_EXPECTED_REPO_URL,
              path: PROVENANCE_EXPECTED_WORKFLOW_PATH,
            },
          },
          resolvedDependencies: [
            {
              uri: 'git+...',
              digest: { gitCommit: 'ca53b5a14df53a0d40570a1dfde3ffa0e8325bdc' },
            },
          ],
        },
      },
    };
  }

  it('passes a clean SLSA statement', () => {
    const issues = validateAttestationClaims(cleanStatement(), {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('handles the URL-encoded subject form (%40plccopilot%2fcli)', () => {
    const stmt = cleanStatement() as any;
    stmt.subject[0].name = 'pkg:npm/%40plccopilot%2Fcli@0.1.0';
    const errors = validateAttestationClaims(stmt, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });

  it('emits PROVENANCE_ATTESTATION_REPO_MISMATCH on wrong subject', () => {
    const stmt = cleanStatement() as any;
    stmt.subject[0].name = 'pkg:npm/left-pad@0.0.1';
    const codes = validateAttestationClaims(stmt, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_ATTESTATION_REPO_MISMATCH');
  });

  it('emits PROVENANCE_ATTESTATION_REPO_MISMATCH on wrong workflow.repository', () => {
    const stmt = cleanStatement() as any;
    stmt.predicate.buildDefinition.externalParameters.workflow.repository =
      'https://github.com/other/repo';
    const codes = validateAttestationClaims(stmt, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_ATTESTATION_REPO_MISMATCH');
  });

  it('emits PROVENANCE_ATTESTATION_WORKFLOW_MISMATCH on wrong workflow.path', () => {
    const stmt = cleanStatement() as any;
    stmt.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/wrong.yml';
    const codes = validateAttestationClaims(stmt, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_ATTESTATION_WORKFLOW_MISMATCH');
  });

  it('emits PROVENANCE_ATTESTATION_REPO_MISMATCH on wrong predicateType', () => {
    const stmt = cleanStatement() as any;
    stmt.predicateType = 'https://example.com/other';
    const codes = validateAttestationClaims(stmt, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    }).map((i) => i.code);
    expect(codes).toContain('PROVENANCE_ATTESTATION_REPO_MISMATCH');
  });

  it('emits a warning (not error) when gitCommit absent', () => {
    const stmt = cleanStatement() as any;
    delete stmt.predicate.buildDefinition.resolvedDependencies;
    const issues = validateAttestationClaims(stmt, {
      packageName: '@plccopilot/cli',
      version: '0.1.0',
    });
    const errors = issues.filter((i) => i.level === 'error');
    const warnings = issues.filter((i) => i.level === 'warning');
    expect(errors).toEqual([]);
    expect(warnings.map((i) => i.code)).toContain('PROVENANCE_ATTESTATION_WORKFLOW_MISMATCH');
  });

  it('reports parse-failed for missing statement / non-object / no subjects', () => {
    expect(
      validateAttestationClaims(null, { packageName: '@plccopilot/cli', version: '0.1.0' }).map(
        (i) => i.code,
      ),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
    const noSubject = cleanStatement() as any;
    delete noSubject.subject;
    expect(
      validateAttestationClaims(noSubject, {
        packageName: '@plccopilot/cli',
        version: '0.1.0',
      }).map((i) => i.code),
    ).toContain('PROVENANCE_ATTESTATION_PARSE_FAILED');
  });
});

// =============================================================================
// extractAttestationGitCommit
// =============================================================================

describe('extractAttestationGitCommit', () => {
  it('returns the recorded gitCommit', () => {
    const stmt = {
      predicate: {
        buildDefinition: {
          resolvedDependencies: [
            { digest: { gitCommit: 'ca53b5a14df53a0d40570a1dfde3ffa0e8325bdc' } },
          ],
        },
      },
    };
    expect(extractAttestationGitCommit(stmt)).toBe(
      'ca53b5a14df53a0d40570a1dfde3ffa0e8325bdc',
    );
  });

  it('returns null when missing or shape mismatched', () => {
    expect(extractAttestationGitCommit(null)).toBeNull();
    expect(extractAttestationGitCommit({})).toBeNull();
    expect(
      extractAttestationGitCommit({
        predicate: { buildDefinition: { resolvedDependencies: [] } },
      }),
    ).toBeNull();
  });

  it('returns null on bogus / non-hex commit', () => {
    expect(
      extractAttestationGitCommit({
        predicate: {
          buildDefinition: {
            resolvedDependencies: [{ digest: { gitCommit: 'not-a-commit' } }],
          },
        },
      }),
    ).toBeNull();
  });
});

// =============================================================================
// buildProvenanceReport
// =============================================================================

describe('buildProvenanceReport', () => {
  function pkg(name = '@plccopilot/cli', issues: any[] = []) {
    return {
      name,
      version: '0.1.0',
      distIntegrity: true,
      tarball: true,
      attestations: {
        present: true,
        url: 'https://example.com',
        predicateType: 'https://slsa.dev/provenance/v1',
        workflowPath: PROVENANCE_EXPECTED_WORKFLOW_PATH,
        repositoryUrl: PROVENANCE_EXPECTED_REPO_URL,
        gitCommit: 'ca53b5a14df53a0d40570a1dfde3ffa0e8325bdc',
        claimsVerified: true,
      },
      issues,
    };
  }

  it('config-only report passes when configChecks has no issues', () => {
    const r = buildProvenanceReport({
      mode: 'config-only',
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      configChecks: {
        workflow_id_token_write: true,
        publish_command_provenance_flag: true,
        publish_command_no_dry_run: true,
        issues: [],
      },
      packageResults: null,
    });
    expect(r.ok).toBe(true);
    expect(r.config).not.toBeNull();
    expect(r.packages).toBeNull();
  });

  it('metadata-only report passes for clean per-package results', () => {
    const r = buildProvenanceReport({
      mode: 'metadata-only',
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      configChecks: null,
      packageResults: PROVENANCE_PACKAGE_ORDER.map((n) => pkg(n)),
    });
    expect(r.ok).toBe(true);
    expect(r.config).toBeNull();
    expect(r.packages?.length).toBe(6);
    expect(r.packages?.every((p) => p.attestations.claims_verified)).toBe(true);
  });

  it('default report combines config + metadata', () => {
    const r = buildProvenanceReport({
      mode: 'default',
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      configChecks: {
        workflow_id_token_write: true,
        publish_command_provenance_flag: true,
        publish_command_no_dry_run: true,
        issues: [],
      },
      packageResults: PROVENANCE_PACKAGE_ORDER.map((n) => pkg(n)),
    });
    expect(r.ok).toBe(true);
    expect(r.config).not.toBeNull();
    expect(r.packages?.length).toBe(6);
  });

  it('flips ok=false when any package error issue is present', () => {
    const r = buildProvenanceReport({
      mode: 'metadata-only',
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      configChecks: null,
      packageResults: [
        pkg('@plccopilot/cli', [
          { level: 'error', code: 'PROVENANCE_ATTESTATION_MISSING', message: 'x', recommendation: null },
        ]),
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('does NOT flip ok when only warnings are present', () => {
    const r = buildProvenanceReport({
      mode: 'metadata-only',
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      configChecks: null,
      packageResults: [
        pkg('@plccopilot/cli', [
          { level: 'warning', code: 'PROVENANCE_GIT_HEAD_MISSING', message: 'x', recommendation: null },
        ]),
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('always reports cryptographic_verification.implemented = false', () => {
    const r = buildProvenanceReport({
      mode: 'default',
      version: '0.1.0',
      registry: 'https://registry.npmjs.org',
      configChecks: {
        workflow_id_token_write: true,
        publish_command_provenance_flag: true,
        publish_command_no_dry_run: true,
        issues: [],
      },
      packageResults: PROVENANCE_PACKAGE_ORDER.map((n) => pkg(n)),
    });
    expect(r.cryptographic_verification.implemented).toBe(false);
    expect(r.cryptographic_verification.verified).toBe(false);
    expect(r.cryptographic_verification.note.toLowerCase()).toContain(
      'not implemented',
    );
  });

  it('throws on unknown mode', () => {
    expect(() =>
      buildProvenanceReport({
        mode: 'cosmic' as any,
        version: '0.1.0',
        registry: 'https://r.example',
        configChecks: null,
        packageResults: null,
      }),
    ).toThrow();
  });
});

// =============================================================================
// post-publish-verify.yml — sprint 65 + 70 step assertions
// =============================================================================

describe('post-publish-verify.yml workflow (sprints 65 + 70)', () => {
  const has = existsSync(POST_PUBLISH_PATH);
  const yaml = has ? readFileSync(POST_PUBLISH_PATH, 'utf-8') : '';

  (has ? it : it.skip)('runs release:provenance --config-only before any registry call', () => {
    expect(yaml).toContain('release:provenance');
    expect(yaml).toContain('release:provenance --config-only');
    const provIdx = yaml.indexOf('release:provenance');
    const npmViewIdx = yaml.indexOf('release:npm-view');
    const smokeIdx = yaml.indexOf('release:registry-smoke');
    expect(provIdx).toBeGreaterThan(-1);
    expect(npmViewIdx).toBeGreaterThan(provIdx);
    expect(smokeIdx).toBeGreaterThan(provIdx);
  });

  (has ? it : it.skip)('runs release:npm-view (with and without tag, gated by check_tag input)', () => {
    expect(yaml).toContain('release:npm-view');
    expect(yaml).toContain('check_tag');
    expect(yaml).toMatch(/inputs\.check_tag\s*==\s*true/);
    expect(yaml).toMatch(/inputs\.check_tag\s*==\s*false/);
  });

  (has ? it : it.skip)('runs release:registry-smoke', () => {
    expect(yaml).toContain('release:registry-smoke');
  });

  (has ? it : it.skip)('declares a tag input restricted to next|latest|beta', () => {
    expect(yaml).toContain('npm_tag:');
    for (const tag of ['next', 'latest', 'beta']) {
      expect(yaml).toContain(`- ${tag}`);
    }
  });

  (has ? it : it.skip)('does NOT shell out to `npm publish`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
  });
});

// =============================================================================
// verify-provenance.yml — sprint 70 manual workflow safety
// =============================================================================

describe('verify-provenance.yml workflow safety (sprint 70)', () => {
  const has = existsSync(VERIFY_PROVENANCE_PATH);
  const yaml = has ? readFileSync(VERIFY_PROVENANCE_PATH, 'utf-8') : '';

  (has ? it : it.skip)('is workflow_dispatch only (no push/schedule/pull_request)', () => {
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toMatch(/^on:[\s\S]*push:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*schedule:/m);
    expect(yaml).not.toMatch(/^on:[\s\S]*pull_request:/m);
  });

  (has ? it : it.skip)('declares version / registry / mode inputs', () => {
    expect(yaml).toMatch(/^[ \t]+version:/m);
    expect(yaml).toMatch(/^[ \t]+registry:/m);
    expect(yaml).toMatch(/^[ \t]+mode:/m);
  });

  (has ? it : it.skip)('mode input is a choice with metadata|config|full', () => {
    expect(yaml).toMatch(/mode:[\s\S]*?type:\s*choice/);
    for (const choice of ['metadata', 'config', 'full']) {
      expect(yaml).toContain(`- ${choice}`);
    }
  });

  (has ? it : it.skip)('top-level + job permissions are read-only', () => {
    expect(yaml).toMatch(/^permissions:\s*\n[ \t]+contents:\s*read/m);
    // No `contents: write` anywhere except possibly comments.
    const writeMatch = yaml.match(/^[ \t]+contents:\s*write/m);
    expect(writeMatch).toBeNull();
  });

  (has ? it : it.skip)('does NOT declare an environment (no protected secret needed)', () => {
    expect(yaml).not.toMatch(/^[ \t]+environment:\s*npm-publish/m);
    expect(yaml).not.toMatch(/^[ \t]+environment:\s*github-pages/m);
  });

  (has ? it : it.skip)('does NOT reference NPM_TOKEN or NODE_AUTH_TOKEN in any executable line', () => {
    // Header comments may mention "no NPM_TOKEN" in prose; filter
    // commented lines out before asserting.
    const liveLines = yaml
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trimEnd())
      .filter((l) => l.length > 0 && !l.trimStart().startsWith('#'));
    const live = liveLines.join('\n');
    expect(live).not.toContain('NPM_TOKEN');
    expect(live).not.toContain('NODE_AUTH_TOKEN');
  });

  (has ? it : it.skip)('invokes pnpm release:provenance with --json in every mode', () => {
    expect(yaml).toContain('release:provenance --config-only');
    expect(yaml).toContain('release:provenance --metadata-only');
    expect(yaml).toMatch(/release:provenance\s+--version/);
    const jsonInvocations = yaml.match(/release:provenance[^\n]*--json/g) ?? [];
    expect(jsonInvocations.length).toBeGreaterThanOrEqual(3);
  });

  (has ? it : it.skip)('does NOT shell out to `npm publish` or `npm dist-tag`', () => {
    const shellLines = yaml
      .split('\n')
      .map((l) => l.trimStart())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('name:'));
    expect(shellLines.filter((l) => /^npm\s+publish\b/.test(l))).toEqual([]);
    expect(shellLines.filter((l) => /^npm\s+dist-tag\b/.test(l))).toEqual([]);
  });

  (has ? it : it.skip)('uses pnpm/action-setup + Node 24', () => {
    expect(yaml).toContain('uses: pnpm/action-setup@v3');
    expect(yaml).toMatch(/version:\s*9/);
    expect(yaml).toContain('node-version: 24');
  });
});

// Sprint 92 — pure tests for the imported codegen preview diff
// bundle parser. The Sprint 91 download bundle is the input; this
// helper turns operator-supplied JSON text back into a validated
// `CodegenPreviewDiffBundle` (or a stable `invalid` view) without
// re-running codegen, mutating inputs, or surfacing any payload
// outside the v1 contract.
//
// What we pin here:
//   - empty / whitespace-only input → empty (no throw).
//   - malformed JSON, wrong kind, wrong version → invalid with a
//     stable user-facing error.
//   - minimum valid Sprint 91 bundle → loaded, with all fields
//     preserved verbatim.
//   - extra / unknown fields (e.g. `content`, raw-source-looking
//     strings) are dropped on the floor — the bundle the helper
//     hands back is rebuilt from the v1 whitelist.
//   - parser does not mutate the input value.
//   - two parses on the same input deep-equal.
//   - rejects bundles with unsupported targets, missing arrays,
//     malformed counts, or non-numeric / negative size fields.
//   - tolerates optional fields: previousBackend null, missing
//     snapshotName (defaults to 'diff'), absent diff sample.
//   - diagnostic + artifact ordering survives unchanged.

import { describe, expect, it } from 'vitest';

import {
  buildCodegenPreviewDiffBundle,
  CODEGEN_PREVIEW_DIFF_BUNDLE_KIND,
  CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION,
  type CodegenPreviewDiffBundle,
} from '../src/utils/codegen-preview-diff-download.js';
import { buildCodegenPreviewView } from '../src/utils/codegen-preview-view.js';
import {
  isSupportedCodegenPreviewDiffBundle,
  parseCodegenPreviewDiffBundle,
  parseCodegenPreviewDiffBundleText,
} from '../src/utils/codegen-preview-diff-import.js';
import type { Project } from '@plccopilot/pir';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';

// ---------------------------------------------------------------------------
// Helpers — produce real bundles from the Sprint 91 builder so the
// test never embeds a hand-rolled JSON drift away from the actual
// shape.
// ---------------------------------------------------------------------------

function happyProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'p_x',
    name: 'x',
    machines: [
      {
        id: 'm_x',
        name: 'm',
        stations: [
          {
            id: 'st_a',
            name: 'A',
            equipment: [
              {
                id: 'eq_b1',
                name: 'B1',
                type: 'sensor_discrete',
                code_symbol: 'B1',
                io_bindings: { feedback: 'io_b1' },
              },
            ],
            sequence: {
              states: [
                { id: 'init', initial: true, activities: [] },
                { id: 's2', activities: [] },
              ],
              transitions: [{ id: 't1', from: 'init', to: 's2' }],
            },
          },
        ],
        io: [
          {
            id: 'io_b1',
            name: 'B1',
            direction: 'in',
            data_type: 'bool',
            address: { memory_area: 'I', byte: 0, bit: 0 },
          },
        ],
        alarms: [],
        interlocks: [],
        parameters: [],
        recipes: [],
        safety_groups: [],
      },
    ],
  } as unknown as Project;
}

function makeArtifact(path: string, content: string): GeneratedArtifact {
  const kind: GeneratedArtifact['kind'] = path.endsWith('.scl')
    ? 'scl'
    : path.endsWith('.json')
      ? 'json'
      : 'st';
  return { path, kind, content };
}

function stub(prefix: string, files: ReadonlyArray<readonly [string, string]>) {
  return () =>
    files.map(([p, c]) => makeArtifact(`${prefix}/${p}`, c));
}

function changedDiffBundle(): CodegenPreviewDiffBundle {
  const prev = buildCodegenPreviewView({
    project: happyProject(),
    selection: 'codesys',
    generators: { codesys: stub('codesys', [['x.st', 'OLD']]) },
  });
  const curr = buildCodegenPreviewView({
    project: happyProject(),
    selection: 'codesys',
    generators: { codesys: stub('codesys', [['x.st', 'NEW']]) },
  });
  return buildCodegenPreviewDiffBundle({
    previousView: prev,
    currentView: curr,
  });
}

function unchangedDiffBundle(): CodegenPreviewDiffBundle {
  const prev = buildCodegenPreviewView({
    project: happyProject(),
    selection: 'siemens',
    generators: { siemens: stub('siemens', [['s.scl', 'S']]) },
  });
  const curr = buildCodegenPreviewView({
    project: happyProject(),
    selection: 'siemens',
    generators: { siemens: stub('siemens', [['s.scl', 'S']]) },
  });
  return buildCodegenPreviewDiffBundle({
    previousView: prev,
    currentView: curr,
  });
}

// =============================================================================
// 1. Empty / malformed text
// =============================================================================

describe('parseCodegenPreviewDiffBundleText — empty / malformed', () => {
  it('1. empty string → empty (no throw)', () => {
    const v = parseCodegenPreviewDiffBundleText('');
    expect(v.status).toBe('empty');
    expect(v.bundle).toBeUndefined();
    expect(v.error).toBeUndefined();
  });

  it('2. whitespace-only → empty', () => {
    expect(parseCodegenPreviewDiffBundleText('   \n\t').status).toBe('empty');
  });

  it('3. malformed JSON → invalid with stable error', () => {
    const v = parseCodegenPreviewDiffBundleText('{not json}');
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/not valid JSON/);
  });
});

// =============================================================================
// 2. Wrong kind / version
// =============================================================================

describe('parseCodegenPreviewDiffBundle — wrong kind / version', () => {
  it('4. missing kind → invalid', () => {
    const v = parseCodegenPreviewDiffBundle({ version: 1, targets: [] });
    expect(v.status).toBe('invalid');
    expect(v.error).toContain(CODEGEN_PREVIEW_DIFF_BUNDLE_KIND);
  });

  it('5. wrong kind → invalid', () => {
    const v = parseCodegenPreviewDiffBundle({
      kind: 'plc-copilot-codegen-preview', // Sprint 90A bundle kind
      version: 1,
    });
    expect(v.status).toBe('invalid');
    expect(v.error).toContain(CODEGEN_PREVIEW_DIFF_BUNDLE_KIND);
  });

  it('6. wrong version → invalid (loud, no silent upgrade)', () => {
    const v = parseCodegenPreviewDiffBundle({
      kind: CODEGEN_PREVIEW_DIFF_BUNDLE_KIND,
      version: 2,
    });
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/version/i);
  });

  it('7. non-object input → invalid', () => {
    expect(parseCodegenPreviewDiffBundle(42).status).toBe('invalid');
    expect(parseCodegenPreviewDiffBundle('string').status).toBe('invalid');
    expect(parseCodegenPreviewDiffBundle([1, 2, 3]).status).toBe('invalid');
  });

  it('8. null / undefined → empty (operator picked nothing)', () => {
    expect(parseCodegenPreviewDiffBundle(null).status).toBe('empty');
    expect(parseCodegenPreviewDiffBundle(undefined).status).toBe('empty');
  });
});

// =============================================================================
// 3. Minimum valid bundle round-trip
// =============================================================================

describe('parseCodegenPreviewDiffBundle — round trip', () => {
  it('9. real Sprint 91 changed bundle → loaded, all fields preserved', () => {
    const original = changedDiffBundle();
    const text = JSON.stringify(original);
    const v = parseCodegenPreviewDiffBundleText(text);
    expect(v.status).toBe('loaded');
    expect(v.bundle).toEqual(original);
    expect(v.summary).toMatch(/Imported diff/);
  });

  it('10. real Sprint 91 unchanged bundle → loaded, state preserved', () => {
    const original = unchangedDiffBundle();
    const v = parseCodegenPreviewDiffBundle(original);
    expect(v.status).toBe('loaded');
    expect(v.bundle?.state).toBe('unchanged');
    expect(v.bundle?.targets[0].state).toBe('unchanged');
  });

  it('11. helper does not mutate the input value', () => {
    const original = changedDiffBundle();
    const before = JSON.stringify(original);
    parseCodegenPreviewDiffBundle(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('12. two parses on the same input deep-equal', () => {
    const original = changedDiffBundle();
    const a = parseCodegenPreviewDiffBundle(original);
    const b = parseCodegenPreviewDiffBundle(original);
    expect(a).toEqual(b);
  });

  it('13. selection / backend / counts preserved verbatim', () => {
    const original = changedDiffBundle();
    const v = parseCodegenPreviewDiffBundle(original);
    expect(v.bundle?.selection.backend).toBe(original.selection.backend);
    expect(v.bundle?.selection.previousBackend).toBe(
      original.selection.previousBackend,
    );
    expect(v.bundle?.selection.selectionMatch).toBe(
      original.selection.selectionMatch,
    );
    expect(v.bundle?.counts).toEqual(original.counts);
  });

  it('14. artifact + diagnostic order is preserved', () => {
    const original = changedDiffBundle();
    const v = parseCodegenPreviewDiffBundle(original);
    expect(
      v.bundle!.targets[0].artifactChanges.map((a) => a.path),
    ).toEqual(original.targets[0].artifactChanges.map((a) => a.path));
    expect(
      v.bundle!.targets[0].diagnosticChanges.map(
        (d) => `${d.status}|${d.code}`,
      ),
    ).toEqual(
      original.targets[0].diagnosticChanges.map(
        (d) => `${d.status}|${d.code}`,
      ),
    );
  });

  it('15. backend "all" diff bundle round-trips', () => {
    const prev = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        siemens: stub('siemens', [['s.scl', 'S']]),
        codesys: stub('codesys', [['c.st', 'C']]),
        rockwell: stub('rockwell', [['r.st', 'R']]),
      },
    });
    const curr = buildCodegenPreviewView({
      project: happyProject(),
      selection: 'all',
      generators: {
        siemens: stub('siemens', [['s.scl', 'S2']]),
        codesys: stub('codesys', [['c.st', 'C']]),
        rockwell: stub('rockwell', [['r.st', 'R2']]),
      },
    });
    const original = buildCodegenPreviewDiffBundle({
      previousView: prev,
      currentView: curr,
    });
    const v = parseCodegenPreviewDiffBundle(original);
    expect(v.status).toBe('loaded');
    expect(v.bundle!.targets.map((t) => t.target)).toEqual([
      'siemens',
      'codesys',
      'rockwell',
    ]);
    expect(v.bundle!.selection.backend).toBe('all');
  });
});

// =============================================================================
// 4. Whitelist / privacy
// =============================================================================

describe('parseCodegenPreviewDiffBundle — whitelist / privacy', () => {
  it('16. extra top-level fields are stripped from the rebuilt bundle', () => {
    const original = changedDiffBundle();
    const polluted = {
      ...JSON.parse(JSON.stringify(original)),
      // Pretend a future format drift sneaks in raw payloads.
      rawPdfBytes: 'should-not-survive',
      pir_version: '0.1.0',
      content: 'FUNCTION_BLOCK X END_FUNCTION_BLOCK',
    } as Record<string, unknown>;
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('loaded');
    const json = JSON.stringify(v.bundle);
    expect(json).not.toContain('should-not-survive');
    expect(json).not.toContain('"pir_version"');
    expect(json).not.toContain('FUNCTION_BLOCK X');
    expect(json).not.toContain('"content"');
  });

  it('17. extra per-artifact fields (e.g. content) are dropped', () => {
    const original = changedDiffBundle();
    const polluted = JSON.parse(JSON.stringify(original));
    polluted.targets[0].artifactChanges[0].content =
      'FULL_FILE_CONTENT_THAT_MUST_NOT_LEAK';
    polluted.targets[0].artifactChanges[0].rawCsv = 'row_kind,name,address\n';
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('loaded');
    const json = JSON.stringify(v.bundle);
    expect(json).not.toContain('FULL_FILE_CONTENT_THAT_MUST_NOT_LEAK');
    expect(json).not.toContain('row_kind,');
  });

  it('18. extra per-target fields are dropped', () => {
    const original = changedDiffBundle();
    const polluted = JSON.parse(JSON.stringify(original));
    polluted.targets[0].secretSourceRef = '<EplanProject>...</EplanProject>';
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('loaded');
    const json = JSON.stringify(v.bundle);
    expect(json).not.toContain('<EplanProject');
  });
});

// =============================================================================
// 5. Defensive validation
// =============================================================================

describe('parseCodegenPreviewDiffBundle — defensive validation', () => {
  it('19. missing targets array → invalid', () => {
    const polluted = { ...changedDiffBundle() } as unknown as Record<
      string,
      unknown
    >;
    delete polluted.targets;
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/targets/);
  });

  it('20. unsupported target name → invalid', () => {
    const polluted = JSON.parse(JSON.stringify(changedDiffBundle()));
    polluted.targets[0].target = 'core'; // not a vendor preview target
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('invalid');
  });

  it('21. malformed counts (negative number) → invalid', () => {
    const polluted = JSON.parse(JSON.stringify(changedDiffBundle()));
    polluted.counts.targetsCompared = -1;
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/counts/);
  });

  it('22. malformed selection (missing backend) → invalid', () => {
    const polluted = JSON.parse(JSON.stringify(changedDiffBundle()));
    delete polluted.selection.backend;
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/selection/);
  });

  it('23. unsupported state → invalid', () => {
    const polluted = JSON.parse(JSON.stringify(changedDiffBundle()));
    polluted.state = 'sideways';
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('invalid');
    expect(v.error).toMatch(/state/);
  });

  it('24. malformed diagnostic (missing code) → invalid', () => {
    const polluted = JSON.parse(JSON.stringify(unchangedDiffBundle()));
    // Inject a bad diagnostic on the unchanged target.
    polluted.targets[0].diagnosticChanges.push({
      status: 'added',
      severity: 'warning',
      // missing code/message
    });
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('invalid');
  });

  it('25. snapshotName missing → defaults to "diff", still loaded', () => {
    const polluted = JSON.parse(JSON.stringify(unchangedDiffBundle()));
    delete polluted.snapshotName;
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('loaded');
    expect(v.bundle!.snapshotName).toBe('diff');
  });

  it('26. previousBackend can be null (no baseline back at write time)', () => {
    const polluted = JSON.parse(JSON.stringify(changedDiffBundle()));
    polluted.selection.previousBackend = null;
    polluted.selection.selectionMatch = false;
    const v = parseCodegenPreviewDiffBundle(polluted);
    expect(v.status).toBe('loaded');
    expect(v.bundle!.selection.previousBackend).toBeNull();
  });
});

// =============================================================================
// 6. isSupportedCodegenPreviewDiffBundle predicate
// =============================================================================

describe('isSupportedCodegenPreviewDiffBundle', () => {
  it('27. returns true for a valid Sprint 91 bundle', () => {
    expect(isSupportedCodegenPreviewDiffBundle(changedDiffBundle())).toBe(true);
  });

  it('28. returns false for a wrong kind, wrong version, or junk', () => {
    expect(isSupportedCodegenPreviewDiffBundle(null)).toBe(false);
    expect(isSupportedCodegenPreviewDiffBundle({})).toBe(false);
    expect(
      isSupportedCodegenPreviewDiffBundle({
        kind: 'plc-copilot-codegen-preview',
        version: CODEGEN_PREVIEW_DIFF_BUNDLE_VERSION,
      }),
    ).toBe(false);
  });
});

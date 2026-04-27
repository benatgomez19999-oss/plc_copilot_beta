import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { diffPirValues } from '../src/utils/pir-diff.js';
import {
  changedDescendantPaths,
  changedStructurePathsFromDiffs,
  firstChangedDescendantPath,
  formatStructureChangeBreakdown,
  getChangedStructurePaths,
  getStructureChangeCounts,
  isDiffUnderNodePath,
  structureChangeBreakdownsFromDiffs,
  structureChangeCountsFromDiffs,
} from '../src/utils/structure-diff.js';
import type { PirDiffEntry } from '../src/utils/pir-diff.js';

function fixtureProject(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('changedStructurePathsFromDiffs — single-path lifts', () => {
  it('marks an equipment field change up through equipment / station / machine / root', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'Renamed cyl';
    const set = changedStructurePathsFromDiffs(diffPirValues(applied, draft));
    expect(set).toEqual(
      new Set([
        '$',
        '$.machines[0]',
        '$.machines[0].stations[0]',
        '$.machines[0].stations[0].equipment[0]',
      ]),
    );
  });

  it('marks a station name change up through station / machine / root', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[1]!.name = 'New weld';
    const set = changedStructurePathsFromDiffs(diffPirValues(applied, draft));
    expect(set).toEqual(
      new Set(['$', '$.machines[0]', '$.machines[0].stations[1]']),
    );
  });

  it('marks a machine name change up through machine / root', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.name = 'New machine';
    const set = changedStructurePathsFromDiffs(diffPirValues(applied, draft));
    expect(set).toEqual(new Set(['$', '$.machines[0]']));
  });

  it('marks a project-root field change as just $', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.name = 'Renamed Project';
    const set = changedStructurePathsFromDiffs(diffPirValues(applied, draft));
    expect(set).toEqual(new Set(['$']));
  });

  it('returns an empty set when applied and draft are deeply equal', () => {
    const applied = fixtureProject();
    expect(
      changedStructurePathsFromDiffs(
        diffPirValues(applied, structuredClone(applied)),
      ),
    ).toEqual(new Set());
  });
});

describe('changedStructurePathsFromDiffs — paths beyond equipment', () => {
  it('changes inside machine.io still mark the machine + root only (no equipment)', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.io[0]!.name = 'Renamed signal';
    const set = changedStructurePathsFromDiffs(diffPirValues(applied, draft));
    expect(set).toEqual(new Set(['$', '$.machines[0]']));
  });

  it('changes inside an equipment subtree (timing) mark the equipment too', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    // Mutate timing on cyl01 — diff path runs through the equipment.
    const eq = draft.machines[0]!.stations[0]!.equipment[0]!;
    eq.timing = { ...(eq.timing ?? {}), extend_timeout_ms: 9999 };
    const set = changedStructurePathsFromDiffs(diffPirValues(applied, draft));
    expect(set.has('$.machines[0].stations[0].equipment[0]')).toBe(true);
    expect(set.has('$.machines[0].stations[0]')).toBe(true);
    expect(set.has('$.machines[0]')).toBe(true);
    expect(set.has('$')).toBe(true);
  });
});

describe('getChangedStructurePaths — null guards', () => {
  it('returns an empty set when applied is null', () => {
    expect(getChangedStructurePaths(null, fixtureProject())).toEqual(new Set());
  });

  it('returns an empty set when draft is null', () => {
    expect(getChangedStructurePaths(fixtureProject(), null)).toEqual(new Set());
  });
});

// =============================================================================
// getStructureChangeCounts / structureChangeCountsFromDiffs
// =============================================================================

describe('structureChangeCountsFromDiffs — single diff entry', () => {
  it('counts 1 for equipment + station + machine + root on an equipment field change', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'Renamed cyl';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[1]')).toBeUndefined();
  });

  it('counts 1 for station + machine + root on a station-level field change', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[1]!.name = 'New weld';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[1]')).toBe(1);
    // No equipment-level entry for a station-name change.
    expect(counts.get('$.machines[0].stations[1].equipment[0]')).toBeUndefined();
  });

  it('counts 1 for machine + root only on a machine-level IO field change', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.io[0]!.name = 'Renamed signal';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$')).toBe(1);
    expect(counts.get('$.machines[0]')).toBe(1);
    // The diff lives under `machines[0].io[0]` — no station / equipment owns it.
    expect(counts.get('$.machines[0].stations[0]')).toBeUndefined();
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBeUndefined();
  });

  it('counts 1 only for the root on a project-level field change', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.name = 'Renamed Project';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$')).toBe(1);
    expect(counts.size).toBe(1);
  });
});

describe('structureChangeCountsFromDiffs — multiple diff entries roll up', () => {
  it('three field changes under one equipment count 3 at every ancestor', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    const eq = draft.machines[0]!.stations[0]!.equipment[0]!;
    eq.name = 'A';
    eq.code_symbol = 'CylA';
    eq.description = 'New desc';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$')).toBe(3);
    expect(counts.get('$.machines[0]')).toBe(3);
    expect(counts.get('$.machines[0].stations[0]')).toBe(3);
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBe(3);
  });

  it('changes spread across siblings sum at the ancestor but not at the siblings', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    // Change a field on each of the two equipment items in st_load.
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'A';
    draft.machines[0]!.stations[0]!.equipment[1]!.name = 'B';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0].equipment[1]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0]')).toBe(2);
    expect(counts.get('$.machines[0]')).toBe(2);
    expect(counts.get('$')).toBe(2);
  });

  it('mixes machine-only and equipment-level diffs without cross-contamination', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    // 1× machine-level (io), 1× equipment-level (name).
    draft.machines[0]!.io[0]!.name = 'Renamed signal';
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'Renamed cyl';
    const counts = structureChangeCountsFromDiffs(diffPirValues(applied, draft));
    expect(counts.get('$')).toBe(2);
    expect(counts.get('$.machines[0]')).toBe(2);
    expect(counts.get('$.machines[0].stations[0]')).toBe(1);
    expect(counts.get('$.machines[0].stations[0].equipment[0]')).toBe(1);
  });
});

describe('structureChangeCountsFromDiffs — empty / null', () => {
  it('returns an empty Map for an empty diff list', () => {
    expect(structureChangeCountsFromDiffs([])).toEqual(new Map());
  });

  it('returns an empty Map when applied or draft is null (via getStructureChangeCounts)', () => {
    expect(getStructureChangeCounts(null, fixtureProject())).toEqual(new Map());
    expect(getStructureChangeCounts(fixtureProject(), null)).toEqual(new Map());
  });

  it('returns an empty Map when applied and draft are deeply equal', () => {
    const applied = fixtureProject();
    expect(
      getStructureChangeCounts(applied, structuredClone(applied)),
    ).toEqual(new Map());
  });
});

describe('changedStructurePathsFromDiffs derives from counts', () => {
  it('Set membership equals Map keys for any input', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'X';
    draft.name = 'Y';
    const diffs = diffPirValues(applied, draft);
    const set = changedStructurePathsFromDiffs(diffs);
    const map = structureChangeCountsFromDiffs(diffs);
    expect(set).toEqual(new Set(map.keys()));
  });
});

// =============================================================================
// isDiffUnderNodePath
// =============================================================================

describe('isDiffUnderNodePath', () => {
  it('the project root matches every non-empty diff path', () => {
    expect(isDiffUnderNodePath('$.machines[0].name', '$')).toBe(true);
    expect(
      isDiffUnderNodePath('$.machines[0].stations[0].equipment[0].name', '$'),
    ).toBe(true);
    expect(isDiffUnderNodePath('$', '$')).toBe(true);
  });

  it('returns true for an exact-equal path', () => {
    expect(
      isDiffUnderNodePath('$.machines[0]', '$.machines[0]'),
    ).toBe(true);
  });

  it('returns true when the diff path continues with `.` (object descent)', () => {
    expect(
      isDiffUnderNodePath('$.machines[0].name', '$.machines[0]'),
    ).toBe(true);
    expect(
      isDiffUnderNodePath(
        '$.machines[0].stations[1].name',
        '$.machines[0].stations[1]',
      ),
    ).toBe(true);
  });

  it('returns true when the diff path continues with `[` (further indexing)', () => {
    expect(
      isDiffUnderNodePath(
        '$.machines[0].stations[1].equipment[0].name',
        '$.machines[0].stations[1]',
      ),
    ).toBe(true);
  });

  it('does NOT match a longer adjacent index (no `stations[1]` vs `stations[10]` trap)', () => {
    expect(
      isDiffUnderNodePath(
        '$.machines[0].stations[10].name',
        '$.machines[0].stations[1]',
      ),
    ).toBe(false);
  });

  it('does NOT match a sibling at the same level', () => {
    expect(
      isDiffUnderNodePath(
        '$.machines[0].stations[0].name',
        '$.machines[0].stations[1]',
      ),
    ).toBe(false);
  });

  it('rejects empty strings on either side', () => {
    expect(isDiffUnderNodePath('', '$')).toBe(false);
    expect(isDiffUnderNodePath('$.name', '')).toBe(false);
    expect(isDiffUnderNodePath('', '')).toBe(false);
  });
});

// =============================================================================
// firstChangedDescendantPath
// =============================================================================

const SAMPLE_DIFFS: PirDiffEntry[] = [
  {
    path: '$.machines[0].name',
    kind: 'changed',
    appliedValue: 'A',
    draftValue: 'B',
  },
  {
    path: '$.machines[0].stations[1].equipment[0].name',
    kind: 'changed',
    appliedValue: 'X',
    draftValue: 'Y',
  },
  {
    path: '$.machines[0].stations[1].equipment[0].code_symbol',
    kind: 'changed',
    appliedValue: 'Cyl',
    draftValue: 'CylA',
  },
];

describe('firstChangedDescendantPath', () => {
  it('the project root resolves to the very first diff', () => {
    expect(firstChangedDescendantPath('$', SAMPLE_DIFFS)).toBe(
      '$.machines[0].name',
    );
  });

  it('a machine node resolves to its first descendant diff in scan order', () => {
    expect(
      firstChangedDescendantPath('$.machines[0]', SAMPLE_DIFFS),
    ).toBe('$.machines[0].name');
  });

  it('a station node resolves to the first diff under that station, skipping siblings', () => {
    expect(
      firstChangedDescendantPath(
        '$.machines[0].stations[1]',
        SAMPLE_DIFFS,
      ),
    ).toBe('$.machines[0].stations[1].equipment[0].name');
  });

  it('an equipment node resolves to a leaf field diff under it', () => {
    expect(
      firstChangedDescendantPath(
        '$.machines[0].stations[1].equipment[0]',
        SAMPLE_DIFFS,
      ),
    ).toBe('$.machines[0].stations[1].equipment[0].name');
  });

  it('returns null when no diff resolves under the node', () => {
    expect(
      firstChangedDescendantPath('$.machines[0].stations[0]', SAMPLE_DIFFS),
    ).toBeNull();
  });

  it('returns null when the diff list is empty', () => {
    expect(firstChangedDescendantPath('$', [])).toBeNull();
  });

  it('returns null when nodePath is empty', () => {
    expect(firstChangedDescendantPath('', SAMPLE_DIFFS)).toBeNull();
  });

  it('does NOT cross-resolve adjacent indices (stations[1] != stations[10])', () => {
    const diffs: PirDiffEntry[] = [
      {
        path: '$.machines[0].stations[10].name',
        kind: 'changed',
        appliedValue: 'A',
        draftValue: 'B',
      },
    ];
    expect(
      firstChangedDescendantPath('$.machines[0].stations[1]', diffs),
    ).toBeNull();
  });

  it('matches a diff at the exact node path (the node itself was added/removed/changed)', () => {
    const diffs: PirDiffEntry[] = [
      {
        path: '$.machines[0].stations[2]',
        kind: 'added',
        draftValue: { id: 'st_new' },
      },
    ];
    expect(
      firstChangedDescendantPath('$.machines[0].stations[2]', diffs),
    ).toBe('$.machines[0].stations[2]');
  });

  it('preserves diff order — the first matching entry wins even if later entries are deeper', () => {
    const diffs: PirDiffEntry[] = [
      {
        path: '$.machines[0].stations[0].equipment[0].code_symbol',
        kind: 'changed',
        appliedValue: 'X',
        draftValue: 'Y',
      },
      {
        path: '$.machines[0].stations[0].name',
        kind: 'changed',
        appliedValue: 'A',
        draftValue: 'B',
      },
    ];
    expect(
      firstChangedDescendantPath('$.machines[0].stations[0]', diffs),
    ).toBe('$.machines[0].stations[0].equipment[0].code_symbol');
  });
});

// =============================================================================
// changedDescendantPaths
// =============================================================================

describe('changedDescendantPaths', () => {
  it('the project root returns every diff path in original order', () => {
    expect(changedDescendantPaths('$', SAMPLE_DIFFS)).toEqual([
      '$.machines[0].name',
      '$.machines[0].stations[1].equipment[0].name',
      '$.machines[0].stations[1].equipment[0].code_symbol',
    ]);
  });

  it('a station node returns only its descendant paths, in order', () => {
    expect(
      changedDescendantPaths('$.machines[0].stations[1]', SAMPLE_DIFFS),
    ).toEqual([
      '$.machines[0].stations[1].equipment[0].name',
      '$.machines[0].stations[1].equipment[0].code_symbol',
    ]);
  });

  it('an equipment node returns only that equipment’s leaf paths', () => {
    expect(
      changedDescendantPaths(
        '$.machines[0].stations[1].equipment[0]',
        SAMPLE_DIFFS,
      ),
    ).toEqual([
      '$.machines[0].stations[1].equipment[0].name',
      '$.machines[0].stations[1].equipment[0].code_symbol',
    ]);
  });

  it('an exact node-path match is included as a single entry', () => {
    const diffs: PirDiffEntry[] = [
      {
        path: '$.machines[0].stations[2]',
        kind: 'added',
        draftValue: { id: 'st_new' },
      },
      {
        path: '$.machines[0].stations[2].name',
        kind: 'changed',
        appliedValue: 'A',
        draftValue: 'B',
      },
    ];
    expect(
      changedDescendantPaths('$.machines[0].stations[2]', diffs),
    ).toEqual([
      '$.machines[0].stations[2]',
      '$.machines[0].stations[2].name',
    ]);
  });

  it('dedupes identical paths, preserving the first occurrence', () => {
    const diffs: PirDiffEntry[] = [
      {
        path: '$.machines[0].name',
        kind: 'changed',
        appliedValue: 'A',
        draftValue: 'B',
      },
      {
        path: '$.machines[0].name',
        kind: 'changed',
        appliedValue: 'A',
        draftValue: 'C',
      },
      {
        path: '$.machines[0].description',
        kind: 'added',
        draftValue: 'desc',
      },
    ];
    expect(changedDescendantPaths('$', diffs)).toEqual([
      '$.machines[0].name',
      '$.machines[0].description',
    ]);
  });

  it('returns [] when no diff resolves under the node', () => {
    expect(
      changedDescendantPaths('$.machines[0].stations[0]', SAMPLE_DIFFS),
    ).toEqual([]);
  });

  it('returns [] when the diff list is empty', () => {
    expect(changedDescendantPaths('$', [])).toEqual([]);
  });

  it('returns [] when nodePath is empty', () => {
    expect(changedDescendantPaths('', SAMPLE_DIFFS)).toEqual([]);
  });

  it('does NOT cross-resolve adjacent indices (stations[1] != stations[10])', () => {
    const diffs: PirDiffEntry[] = [
      {
        path: '$.machines[0].stations[10].name',
        kind: 'changed',
        appliedValue: 'A',
        draftValue: 'B',
      },
      {
        path: '$.machines[0].stations[1].name',
        kind: 'changed',
        appliedValue: 'X',
        draftValue: 'Y',
      },
    ];
    expect(
      changedDescendantPaths('$.machines[0].stations[1]', diffs),
    ).toEqual(['$.machines[0].stations[1].name']);
  });

  it('firstChangedDescendantPath agrees with changedDescendantPaths()[0]', () => {
    // The cycle helper and the first-only helper share one filter
    // predicate now; this test locks the equivalence in.
    expect(firstChangedDescendantPath('$', SAMPLE_DIFFS)).toBe(
      changedDescendantPaths('$', SAMPLE_DIFFS)[0],
    );
    expect(
      firstChangedDescendantPath('$.machines[0].stations[0]', SAMPLE_DIFFS),
    ).toBeNull();
    expect(
      changedDescendantPaths('$.machines[0].stations[0]', SAMPLE_DIFFS),
    ).toEqual([]);
  });
});

// =============================================================================
// structureChangeBreakdownsFromDiffs
// =============================================================================

describe('structureChangeBreakdownsFromDiffs — kind buckets', () => {
  it('one changed equipment field counts 1 changed at every ancestor', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'Renamed';
    const map = structureChangeBreakdownsFromDiffs(diffPirValues(applied, draft));
    for (const path of [
      '$',
      '$.machines[0]',
      '$.machines[0].stations[0]',
      '$.machines[0].stations[0].equipment[0]',
    ]) {
      expect(map.get(path)).toEqual({
        total: 1,
        added: 0,
        removed: 0,
        changed: 1,
      });
    }
  });

  it('an added array element bumps the `added` bucket along its ancestors', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    // Append a third station so `diffPirValues` emits an `added` entry
    // at `$.machines[0].stations[2]`.
    draft.machines[0]!.stations.push({
      id: 'st_new',
      name: 'New',
      equipment: [],
      sequence: { states: [], transitions: [] },
    });
    const map = structureChangeBreakdownsFromDiffs(diffPirValues(applied, draft));
    expect(map.get('$')).toEqual({
      total: 1,
      added: 1,
      removed: 0,
      changed: 0,
    });
    expect(map.get('$.machines[0]')).toEqual({
      total: 1,
      added: 1,
      removed: 0,
      changed: 0,
    });
    expect(map.get('$.machines[0].stations[2]')).toEqual({
      total: 1,
      added: 1,
      removed: 0,
      changed: 0,
    });
    // The added subtree is NOT recursed (`added` carries the whole
    // value), so no equipment-level entry under stations[2].
    expect(
      map.get('$.machines[0].stations[2].equipment[0]'),
    ).toBeUndefined();
  });

  it('a removed array element bumps the `removed` bucket', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    // Drop equipment[1] from st_load.
    draft.machines[0]!.stations[0]!.equipment.pop();
    const map = structureChangeBreakdownsFromDiffs(diffPirValues(applied, draft));
    expect(map.get('$')).toEqual({
      total: 1,
      added: 0,
      removed: 1,
      changed: 0,
    });
    expect(map.get('$.machines[0].stations[0].equipment[1]')).toEqual({
      total: 1,
      added: 0,
      removed: 1,
      changed: 0,
    });
  });

  it('mixes kinds under one equipment — totals and buckets sum correctly', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    const eq = draft.machines[0]!.stations[0]!.equipment[0]!;
    eq.name = 'A'; // changed
    eq.code_symbol = 'CylA'; // changed
    eq.description = 'New desc'; // added (description is optional and absent on the fixture)
    const map = structureChangeBreakdownsFromDiffs(diffPirValues(applied, draft));
    expect(map.get('$.machines[0].stations[0].equipment[0]')).toEqual({
      total: 3,
      added: 1,
      removed: 0,
      changed: 2,
    });
    // Same numbers roll up to ancestors.
    expect(map.get('$')).toEqual({
      total: 3,
      added: 1,
      removed: 0,
      changed: 2,
    });
  });

  it('a machine-level IO `changed` does NOT contaminate any station / equipment bucket', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.io[0]!.name = 'Renamed signal';
    const map = structureChangeBreakdownsFromDiffs(diffPirValues(applied, draft));
    expect(map.get('$')).toEqual({
      total: 1,
      added: 0,
      removed: 0,
      changed: 1,
    });
    expect(map.get('$.machines[0]')).toEqual({
      total: 1,
      added: 0,
      removed: 0,
      changed: 1,
    });
    expect(map.get('$.machines[0].stations[0]')).toBeUndefined();
    expect(
      map.get('$.machines[0].stations[0].equipment[0]'),
    ).toBeUndefined();
  });

  it('returns an empty Map for an empty diff list', () => {
    expect(structureChangeBreakdownsFromDiffs([])).toEqual(new Map());
  });

  it('total per bucket equals what structureChangeCountsFromDiffs reports', () => {
    const applied = fixtureProject();
    const draft = structuredClone(applied);
    draft.machines[0]!.stations[0]!.equipment[0]!.name = 'A';
    draft.machines[0]!.stations[0]!.equipment[1]!.name = 'B';
    draft.name = 'NewProject';
    const diffs = diffPirValues(applied, draft);
    const counts = structureChangeCountsFromDiffs(diffs);
    const breakdowns = structureChangeBreakdownsFromDiffs(diffs);
    for (const [path, n] of counts) {
      expect(breakdowns.get(path)?.total).toBe(n);
    }
    // Same key set both ways.
    expect(new Set(counts.keys())).toEqual(new Set(breakdowns.keys()));
  });
});

// =============================================================================
// formatStructureChangeBreakdown
// =============================================================================

describe('formatStructureChangeBreakdown', () => {
  it('returns "No pending changes" when total is zero', () => {
    expect(
      formatStructureChangeBreakdown({
        total: 0,
        added: 0,
        removed: 0,
        changed: 0,
      }),
    ).toBe('No pending changes');
  });

  it('renders a single bucket without a separator', () => {
    expect(
      formatStructureChangeBreakdown({
        total: 1,
        added: 0,
        removed: 0,
        changed: 1,
      }),
    ).toBe('1 changed');
    expect(
      formatStructureChangeBreakdown({
        total: 2,
        added: 2,
        removed: 0,
        changed: 0,
      }),
    ).toBe('2 added');
    expect(
      formatStructureChangeBreakdown({
        total: 1,
        added: 0,
        removed: 1,
        changed: 0,
      }),
    ).toBe('1 removed');
  });

  it('joins multiple buckets in the canonical order changed → added → removed', () => {
    expect(
      formatStructureChangeBreakdown({
        total: 3,
        added: 1,
        removed: 0,
        changed: 2,
      }),
    ).toBe('2 changed · 1 added');
    expect(
      formatStructureChangeBreakdown({
        total: 2,
        added: 1,
        removed: 1,
        changed: 0,
      }),
    ).toBe('1 added · 1 removed');
    expect(
      formatStructureChangeBreakdown({
        total: 6,
        added: 2,
        removed: 1,
        changed: 3,
      }),
    ).toBe('3 changed · 2 added · 1 removed');
  });

  it('omits zero buckets even when other buckets have values', () => {
    expect(
      formatStructureChangeBreakdown({
        total: 5,
        added: 3,
        removed: 0,
        changed: 2,
      }),
    ).toBe('2 changed · 3 added');
  });
});

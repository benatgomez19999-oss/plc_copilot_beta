import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  buildPirStructure,
  findPirStructureNodeByPath,
  flattenPirStructure,
  type PirStructureNode,
  type PirStructureNodeTree,
} from '../src/utils/pir-structure.js';

function fixtureProject(): Project {
  // structuredClone keeps tests fully isolated — no shared mutable refs.
  return structuredClone(fixture) as unknown as Project;
}

describe('buildPirStructure — weldline fixture', () => {
  it('roots at the project with kind=project and jsonPath=$', () => {
    const tree = buildPirStructure(fixtureProject());
    expect(tree.kind).toBe('project');
    expect(tree.id).toBe('prj_weldline');
    expect(tree.jsonPath).toBe('$');
    expect(tree.label).toBe('Weldline Demo Project');
  });

  it('produces a machine child with the expected jsonPath / counts', () => {
    const tree = buildPirStructure(fixtureProject());
    expect(tree.children).toHaveLength(1);
    const m = tree.children[0]!;
    expect(m.kind).toBe('machine');
    expect(m.jsonPath).toBe('$.machines[0]');
    expect(m.summary.stations).toBe(2);
    // Counts surfaced from the fixture — these are the operator-relevant
    // tallies the navigator shows.
    expect(m.summary.io).toBe(9);
    expect(m.summary.alarms).toBe(3);
    expect(m.summary.interlocks).toBe(1);
    expect(m.summary.parameters).toBe(2);
    expect(m.summary.recipes).toBe(1);
    expect(m.summary.safety_groups).toBe(1);
  });

  it('produces stations under the machine with bracket-indexed paths', () => {
    const tree = buildPirStructure(fixtureProject());
    const m = tree.children[0]!;
    expect(m.children).toHaveLength(2);
    const [load, weld] = m.children;
    expect(load!.kind).toBe('station');
    expect(load!.id).toBe('st_load');
    expect(load!.jsonPath).toBe('$.machines[0].stations[0]');
    expect(weld!.id).toBe('st_weld');
    expect(weld!.jsonPath).toBe('$.machines[0].stations[1]');
  });

  it('station summary includes equipment + sequence counts when sequence exists', () => {
    const tree = buildPirStructure(fixtureProject());
    const load = tree.children[0]!.children[0]!;
    expect(load.summary.equipment).toBe(2);
    // weldline fixture: load station has 5 states, 5 transitions.
    expect(load.summary.states).toBe(5);
    expect(load.summary.transitions).toBe(5);
  });

  it('equipment leaves expose code_symbol as the label and bracket-indexed paths', () => {
    const tree = buildPirStructure(fixtureProject());
    const load = tree.children[0]!.children[0]!;
    expect(load.children).toHaveLength(2);
    const cyl = load.children[0]!;
    expect(cyl.kind).toBe('equipment');
    expect(cyl.id).toBe('cyl01');
    // Equipment label uses code_symbol (Cyl01) — the operator-facing symbol.
    expect(cyl.label).toBe('Cyl01');
    expect(cyl.jsonPath).toBe('$.machines[0].stations[0].equipment[0]');
    expect(cyl.children).toHaveLength(0);
  });
});

describe('flattenPirStructure', () => {
  it('returns a depth-first traversal: project → machine → station → equipment', () => {
    const tree = buildPirStructure(fixtureProject());
    const flat = flattenPirStructure(tree);
    const kinds = flat.map((n) => n.kind);
    // 1 project + 1 machine + 2 stations + (2 + 1) equipment = 7 entries
    expect(kinds).toEqual([
      'project',
      'machine',
      'station',
      'equipment',
      'equipment',
      'station',
      'equipment',
    ]);
  });

  it('preserves the bracket-indexed jsonPath for every node', () => {
    const tree = buildPirStructure(fixtureProject());
    const paths = flattenPirStructure(tree).map((n) => n.jsonPath);
    expect(paths).toEqual([
      '$',
      '$.machines[0]',
      '$.machines[0].stations[0]',
      '$.machines[0].stations[0].equipment[0]',
      '$.machines[0].stations[0].equipment[1]',
      '$.machines[0].stations[1]',
      '$.machines[0].stations[1].equipment[0]',
    ]);
  });

  it('returns fresh summary objects — mutating a flat entry does not touch the tree', () => {
    const tree = buildPirStructure(fixtureProject());
    const flat = flattenPirStructure(tree);
    // Mutate the flat-list machine summary; the tree must be unaffected.
    (flat[1]!.summary as Record<string, unknown>).stations = 999;
    expect(tree.children[0]!.summary.stations).toBe(2);
  });
});

describe('buildPirStructure — defensive fallbacks', () => {
  it('handles a project with no name by falling back to the id label', () => {
    const p = fixtureProject();
    p.name = '';
    const tree = buildPirStructure(p);
    expect(tree.label).toBe(p.id);
  });

  it('handles a machine with no name by falling back to the id label', () => {
    const p = fixtureProject();
    p.machines[0]!.name = '';
    const tree = buildPirStructure(p);
    expect(tree.children[0]!.label).toBe(p.machines[0]!.id);
  });

  it('tolerates a station whose `sequence` field is missing entirely', () => {
    // Strip `sequence` from the second station via the structural cast — the
    // strict PIR schema requires it, but the navigator must not crash on
    // hand-crafted partial fixtures (e.g. early-edit drafts).
    const p = fixtureProject();
    delete (p.machines[0]!.stations[1] as unknown as Record<string, unknown>)
      .sequence;
    const tree = buildPirStructure(p);
    const station = tree.children[0]!.children[1]!;
    expect(station.summary.states).toBe(0);
    expect(station.summary.transitions).toBe(0);
    // The rest of the summary should be intact.
    expect(station.summary.equipment).toBe(1);
  });

  it('counts io_bindings as object keys (the PIR schema is `Record<string, Id>`)', () => {
    const tree = buildPirStructure(fixtureProject());
    // st_load.cyl01 has 3 io_bindings keys: solenoid_out, sensor_extended,
    // sensor_retracted.
    const cyl = tree.children[0]!.children[0]!.children[0]!;
    expect(cyl.summary.io_bindings).toBe(3);
    // st_load.sen_part has 1 io_bindings key: signal_in.
    const sen = tree.children[0]!.children[0]!.children[1]!;
    expect(sen.summary.io_bindings).toBe(1);
  });

  it('omits optional equipment counts when the underlying records are missing', () => {
    // Build a synthetic equipment without io_bindings / timing so the summary
    // helper proves it does not invent counts.
    const p = fixtureProject();
    const eq = p.machines[0]!.stations[1]!.equipment[0]!;
    delete (eq as unknown as Record<string, unknown>).io_bindings;
    delete (eq as unknown as Record<string, unknown>).timing;
    const tree = buildPirStructure(p);
    const eqNode = tree.children[0]!.children[1]!.children[0]!;
    expect('io_bindings' in eqNode.summary).toBe(false);
    expect('timing' in eqNode.summary).toBe(false);
    // type + id always present — they're required fields on Equipment.
    expect(eqNode.summary.id).toBe(eq.id);
    expect(eqNode.summary.type).toBe(eq.type);
  });

  it('falls back to equipment.id when code_symbol is missing', () => {
    const p = fixtureProject();
    delete (p.machines[0]!.stations[0]!.equipment[0]! as unknown as Record<
      string,
      unknown
    >).code_symbol;
    const tree = buildPirStructure(p);
    const eqNode = tree.children[0]!.children[0]!.children[0]!;
    expect(eqNode.label).toBe('cyl01');
  });
});

describe('buildPirStructure — empty-project edge case', () => {
  it('returns a project root with no machine children when machines=[]', () => {
    const p = fixtureProject();
    p.machines = [];
    const tree: PirStructureNodeTree = buildPirStructure(p);
    expect(tree.kind).toBe('project');
    expect(tree.children).toHaveLength(0);
    expect(tree.summary.machines).toBe(0);
    // Flatten should yield exactly one entry — the project itself.
    expect(flattenPirStructure(tree)).toHaveLength(1);
  });
});

describe('buildPirStructure — node refs', () => {
  it('the project root carries an empty refs object', () => {
    const tree = buildPirStructure(fixtureProject());
    expect(tree.refs).toEqual({});
  });

  it('machine nodes carry { machineIndex }', () => {
    const tree = buildPirStructure(fixtureProject());
    expect(tree.children[0]!.refs).toEqual({ machineIndex: 0 });
  });

  it('station nodes carry { machineIndex, stationIndex }', () => {
    const tree = buildPirStructure(fixtureProject());
    const [load, weld] = tree.children[0]!.children;
    expect(load!.refs).toEqual({ machineIndex: 0, stationIndex: 0 });
    expect(weld!.refs).toEqual({ machineIndex: 0, stationIndex: 1 });
  });

  it('equipment nodes carry { machineIndex, stationIndex, equipmentIndex }', () => {
    const tree = buildPirStructure(fixtureProject());
    const cyl = tree.children[0]!.children[0]!.children[0]!;
    const sen = tree.children[0]!.children[0]!.children[1]!;
    const mot = tree.children[0]!.children[1]!.children[0]!;
    expect(cyl.refs).toEqual({
      machineIndex: 0,
      stationIndex: 0,
      equipmentIndex: 0,
    });
    expect(sen.refs).toEqual({
      machineIndex: 0,
      stationIndex: 0,
      equipmentIndex: 1,
    });
    expect(mot.refs).toEqual({
      machineIndex: 0,
      stationIndex: 1,
      equipmentIndex: 0,
    });
  });

  it('flattenPirStructure preserves refs (deep-copied so mutation is local)', () => {
    const tree = buildPirStructure(fixtureProject());
    const flat = flattenPirStructure(tree);
    // Mutate the flat-list machine refs; the tree must be unaffected.
    (flat[1]!.refs as Record<string, number>).machineIndex = 999;
    expect(tree.children[0]!.refs!.machineIndex).toBe(0);
  });
});

// =============================================================================
// findPirStructureNodeByPath (sprint 31)
// =============================================================================

describe('findPirStructureNodeByPath', () => {
  function flatFixture(): PirStructureNode[] {
    return flattenPirStructure(buildPirStructure(fixtureProject()));
  }

  it('13. finds the project root via `$`', () => {
    const found = findPirStructureNodeByPath(flatFixture(), '$');
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('project');
    expect(found!.id).toBe('prj_weldline');
  });

  it('14. finds a machine by its bracket-indexed path', () => {
    const found = findPirStructureNodeByPath(
      flatFixture(),
      '$.machines[0]',
    );
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('machine');
    expect(found!.id).toBe('mch_weldline');
  });

  it('15. finds a station nested under a machine', () => {
    const found = findPirStructureNodeByPath(
      flatFixture(),
      '$.machines[0].stations[1]',
    );
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('station');
    expect(found!.id).toBe('st_weld');
  });

  it('16. finds an equipment leaf under a station', () => {
    const found = findPirStructureNodeByPath(
      flatFixture(),
      '$.machines[0].stations[0].equipment[1]',
    );
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('equipment');
    expect(found!.id).toBe('sen_part');
  });

  it('17. exact-match only — no substring trap (stations[1] vs stations[10])', () => {
    const fakeNodes: PirStructureNode[] = [
      {
        kind: 'project',
        id: 'p',
        label: 'p',
        jsonPath: '$',
        summary: {},
      },
      {
        kind: 'machine',
        id: 'm',
        label: 'm',
        jsonPath: '$.machines[10]',
        summary: {},
      },
    ];
    expect(
      findPirStructureNodeByPath(fakeNodes, '$.machines[1]'),
    ).toBeNull();
    expect(
      findPirStructureNodeByPath(fakeNodes, '$.machines[10]'),
    ).not.toBeNull();
  });

  it('18. returns null for missing or empty path', () => {
    const flat = flatFixture();
    expect(findPirStructureNodeByPath(flat, '')).toBeNull();
    expect(findPirStructureNodeByPath(flat, '$.does_not_exist')).toBeNull();
    expect(findPirStructureNodeByPath([], '$')).toBeNull();
  });

  it('19. returns the first match if duplicate paths appear in input', () => {
    const dups: PirStructureNode[] = [
      {
        kind: 'machine',
        id: 'A',
        label: 'A',
        jsonPath: '$.machines[0]',
        summary: {},
      },
      {
        kind: 'machine',
        id: 'B',
        label: 'B',
        jsonPath: '$.machines[0]',
        summary: {},
      },
    ];
    const found = findPirStructureNodeByPath(dups, '$.machines[0]');
    expect(found?.id).toBe('A');
  });

  it('19b. recurses into `children` when given a tree-rooted array', () => {
    // Pass `[root]` so the function has to descend into children to
    // find a leaf — exercises the duck-typed recursive branch.
    const tree = buildPirStructure(fixtureProject());
    const found = findPirStructureNodeByPath(
      [tree],
      '$.machines[0].stations[0].equipment[0]',
    );
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('equipment');
    expect(found!.id).toBe('cyl01');
  });
});

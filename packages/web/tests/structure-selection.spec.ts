import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { buildPirStructure } from '../src/utils/pir-structure.js';
import {
  pathExistsInStructure,
  preserveOrClearSelection,
} from '../src/utils/structure-selection.js';

function fixtureTree() {
  return buildPirStructure(
    structuredClone(fixture) as unknown as Project,
  );
}

describe('pathExistsInStructure', () => {
  it('returns true for the project root', () => {
    expect(pathExistsInStructure(fixtureTree(), '$')).toBe(true);
  });

  it('returns true for an existing equipment path', () => {
    expect(
      pathExistsInStructure(
        fixtureTree(),
        '$.machines[0].stations[0].equipment[1]',
      ),
    ).toBe(true);
  });

  it('returns false for an out-of-range index', () => {
    expect(
      pathExistsInStructure(fixtureTree(), '$.machines[5]'),
    ).toBe(false);
  });

  it('returns false for an unknown key', () => {
    expect(pathExistsInStructure(fixtureTree(), '$.foo.bar')).toBe(false);
  });

  it('exact-matches: a substring of an existing path does NOT match', () => {
    // The actual path is `$.machines[0].stations[0]`; querying just the
    // machine prefix is also a real path (the machine itself).
    expect(
      pathExistsInStructure(fixtureTree(), '$.machines[0].stations[0].'),
    ).toBe(false);
  });
});

describe('preserveOrClearSelection', () => {
  it('returns the same string when the path still exists in the tree', () => {
    const tree = fixtureTree();
    const path = '$.machines[0].stations[1]';
    expect(preserveOrClearSelection(tree, path)).toBe(path);
  });

  it('returns null when the previously-selected path is gone', () => {
    expect(
      preserveOrClearSelection(fixtureTree(), '$.machines[5].name'),
    ).toBeNull();
  });

  it('passes through null without consulting the tree', () => {
    expect(preserveOrClearSelection(fixtureTree(), null)).toBeNull();
  });

  it('treats `$` as a valid selection when the project root is queried', () => {
    expect(preserveOrClearSelection(fixtureTree(), '$')).toBe('$');
  });
});

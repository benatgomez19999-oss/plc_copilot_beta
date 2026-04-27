import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { projectToPrettyJson } from '../src/utils/project-json.js';
import {
  parseEditableJsonPath,
  setJsonPathValue,
} from '../src/utils/json-patch.js';

function fixtureJson(): string {
  return projectToPrettyJson(structuredClone(fixture) as unknown as Project);
}

// =============================================================================
// parseEditableJsonPath
// =============================================================================

describe('parseEditableJsonPath', () => {
  it('returns [] for the root path `$`', () => {
    expect(parseEditableJsonPath('$')).toEqual([]);
  });

  it('parses dotted + bracket paths', () => {
    expect(parseEditableJsonPath('$.machines[0].stations[1].name')).toEqual([
      'machines',
      0,
      'stations',
      1,
      'name',
    ]);
  });

  it('throws on a malformed path (matches parseJsonPath null returns)', () => {
    expect(() => parseEditableJsonPath('foo[abc]')).toThrow(/Invalid JSONPath/);
    expect(() => parseEditableJsonPath('foo[')).toThrow(/Invalid JSONPath/);
  });
});

// =============================================================================
// setJsonPathValue — happy path
// =============================================================================

describe('setJsonPathValue — root-level fields', () => {
  it('updates `$.name` and re-emits canonical 2-space JSON with trailing \\n', () => {
    const r = setJsonPathValue(fixtureJson(), '$.name', 'Renamed Project');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.jsonText);
    expect(parsed.name).toBe('Renamed Project');
    // Deterministic formatting — 2-space indent + newline at end.
    expect(r.jsonText.endsWith('\n')).toBe(true);
    expect(r.jsonText).toMatch(/\n  "id": /);
  });
});

describe('setJsonPathValue — nested fields', () => {
  it('updates `$.machines[0].name`', () => {
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[0].name',
      'New Machine',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.jsonText);
    expect(parsed.machines[0].name).toBe('New Machine');
  });

  it('updates `$.machines[0].stations[1].name`', () => {
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[0].stations[1].name',
      'Renamed weld station',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.jsonText);
    expect(parsed.machines[0].stations[1].name).toBe('Renamed weld station');
    // Sibling station unchanged.
    expect(parsed.machines[0].stations[0].name).toBe('Load Station');
  });

  it('updates `$.machines[0].stations[0].equipment[0].name`', () => {
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[0].stations[0].equipment[0].name',
      'Renamed cylinder',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.jsonText);
    expect(parsed.machines[0].stations[0].equipment[0].name).toBe(
      'Renamed cylinder',
    );
  });
});

// =============================================================================
// Optional-property creation
// =============================================================================

describe('setJsonPathValue — optional property creation', () => {
  it('creates `description` on a machine when the parent exists but the key does not', () => {
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[0].description',
      'A new description',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.jsonText);
    expect(parsed.machines[0].description).toBe('A new description');
  });

  it('creates `description` on an equipment that did not have one', () => {
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[0].stations[0].equipment[0].description',
      'Adds optional desc',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.jsonText);
    expect(parsed.machines[0].stations[0].equipment[0].description).toBe(
      'Adds optional desc',
    );
  });
});

// =============================================================================
// Errors
// =============================================================================

describe('setJsonPathValue — errors', () => {
  it('rejects the root path `$` (no whole-document replacement here)', () => {
    const r = setJsonPathValue(fixtureJson(), '$', { foo: 'bar' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/root path/i);
  });

  it('returns ok:false when an intermediate key is missing', () => {
    const r = setJsonPathValue(fixtureJson(), '$.does_not_exist.x', 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/does_not_exist/);
  });

  it('returns ok:false when an array index is out of range', () => {
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[5].name',
      'whatever',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/out of range/);
  });

  it('returns ok:false when the leaf array index is out of range', () => {
    // io has 9 entries — index 99 must error rather than silently extending.
    const r = setJsonPathValue(
      fixtureJson(),
      '$.machines[0].io[99]',
      { id: 'x' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/out of range/);
  });

  it('returns ok:false when the input is not valid JSON', () => {
    const r = setJsonPathValue('this is not json', '$.name', 'x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not valid JSON/i);
  });

  it('returns ok:false when a numeric segment is used on a non-array parent', () => {
    // `$.name[0]` — `name` is a string, indexing should be rejected.
    const r = setJsonPathValue(fixtureJson(), '$.name[0]', 'x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/non-array/);
  });

  it('returns ok:false when a string segment is used on an array parent', () => {
    // `$.machines.name` — `machines` is an array, asking for key `name` fails.
    const r = setJsonPathValue(fixtureJson(), '$.machines.name', 'x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/object/);
  });

  it('returns a typed error for a malformed path string', () => {
    const r = setJsonPathValue(fixtureJson(), 'foo[abc]', 'x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Invalid JSONPath/);
  });
});

// =============================================================================
// Determinism + immutability
// =============================================================================

describe('setJsonPathValue — formatting determinism', () => {
  it('produces byte-identical JSON when patching the same path with the same value twice', () => {
    const a = setJsonPathValue(fixtureJson(), '$.name', 'X');
    const b = setJsonPathValue(fixtureJson(), '$.name', 'X');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.jsonText).toBe(b.jsonText);
    }
  });

  it('does not mutate the input string (referential check via re-parse)', () => {
    const input = fixtureJson();
    const before = JSON.parse(input).name;
    setJsonPathValue(input, '$.name', 'After');
    // The function returned a new string; the original input still parses
    // to the original name.
    expect(JSON.parse(input).name).toBe(before);
  });
});

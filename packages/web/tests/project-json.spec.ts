import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { projectToPrettyJson } from '../src/utils/project-json.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('projectToPrettyJson', () => {
  it('returns parseable JSON', () => {
    const out = projectToPrettyJson(clone());
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('round-trips the project through JSON.parse', () => {
    const project = clone();
    const restored = JSON.parse(projectToPrettyJson(project)) as Project;
    expect(restored.id).toBe(project.id);
    expect(restored.name).toBe(project.name);
    expect(restored.machines.length).toBe(project.machines.length);
  });

  it('uses 2-space indentation', () => {
    const out = projectToPrettyJson(clone());
    // The first line is `{`; the second line is the first property indented
    // with exactly two spaces.
    const lines = out.split('\n');
    expect(lines[0]).toBe('{');
    expect(lines[1]).toMatch(/^ {2}"/); // two spaces, then a property
  });

  it('ends with a trailing newline', () => {
    const out = projectToPrettyJson(clone());
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is deterministic across two consecutive calls', () => {
    const a = projectToPrettyJson(clone());
    const b = projectToPrettyJson(clone());
    expect(a).toBe(b);
  });

  it('is non-empty for the canonical fixture', () => {
    const out = projectToPrettyJson(clone());
    expect(out.length).toBeGreaterThan(100);
  });
});

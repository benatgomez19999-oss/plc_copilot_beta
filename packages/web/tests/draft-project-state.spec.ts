import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { projectToPrettyJson } from '../src/utils/project-json.js';
import { getDraftProjectState } from '../src/utils/draft-project-state.js';

function fixtureProject(): Project {
  return structuredClone(fixture) as unknown as Project;
}

function fixtureJson(p: Project = fixtureProject()): string {
  return projectToPrettyJson(p);
}

describe('getDraftProjectState — same-as-applied', () => {
  it('returns kind="same-as-applied" when draft equals canonical applied JSON', () => {
    const applied = fixtureProject();
    const state = getDraftProjectState(fixtureJson(applied), applied);
    expect(state.kind).toBe('same-as-applied');
    if (state.kind !== 'same-as-applied') return;
    expect(state.project.id).toBe(applied.id);
    expect(state.report.issues).toBeDefined();
  });
});

describe('getDraftProjectState — valid distinct draft', () => {
  it('returns kind="valid" when draft parses, validates, and differs', () => {
    const applied = fixtureProject();
    const drafted = structuredClone(applied);
    drafted.name = 'Renamed';
    const state = getDraftProjectState(fixtureJson(drafted), applied);
    expect(state.kind).toBe('valid');
    if (state.kind !== 'valid') return;
    expect(state.project.name).toBe('Renamed');
    expect(state.project.id).toBe(applied.id);
  });

  it('still kind="valid" even when domain validate() reports issues', () => {
    // Force a domain-level issue: an interlock referencing a missing
    // equipment id. validatePirDraft.status stays 'valid' because schema
    // matches; the report carries the failure.
    const applied = fixtureProject();
    const drafted = structuredClone(applied);
    drafted.machines[0]!.interlocks.push({
      id: 'il_dangling',
      inhibits: 'no_such_eq.go',
      when: 'estop_active',
    });
    const state = getDraftProjectState(fixtureJson(drafted), applied);
    expect(state.kind).toBe('valid');
    if (state.kind !== 'valid') return;
    expect(state.report.issues.length).toBeGreaterThan(0);
  });

  it('returns kind="valid" when applied is null and the draft validates', () => {
    const drafted = fixtureProject();
    const state = getDraftProjectState(fixtureJson(drafted), null);
    expect(state.kind).toBe('valid');
  });
});

describe('getDraftProjectState — invalid', () => {
  it('returns reason="json" with the parser message on malformed JSON', () => {
    const state = getDraftProjectState('this is not json', fixtureProject());
    expect(state.kind).toBe('invalid');
    if (state.kind !== 'invalid') return;
    expect(state.reason).toBe('json');
    expect(state.message.length).toBeGreaterThan(0);
  });

  it('returns reason="json" with a clear message on empty input', () => {
    const state = getDraftProjectState('', fixtureProject());
    expect(state.kind).toBe('invalid');
    if (state.kind !== 'invalid') return;
    expect(state.reason).toBe('json');
  });

  it('returns reason="schema" with a path-prefixed message on Zod failure', () => {
    // Drop the required `pir_version` field from a valid JSON document.
    const broken: Record<string, unknown> = JSON.parse(fixtureJson());
    delete broken.pir_version;
    const text = JSON.stringify(broken, null, 2) + '\n';
    const state = getDraftProjectState(text, fixtureProject());
    expect(state.kind).toBe('invalid');
    if (state.kind !== 'invalid') return;
    expect(state.reason).toBe('schema');
    // The message uses the format `<path>: <issue>` for downstream
    // tooltips — not strict regex, but must mention the field.
    expect(state.message).toMatch(/pir_version/);
  });
});

describe('getDraftProjectState — determinism', () => {
  it('two calls with identical inputs yield deeply-equal results', () => {
    const applied = fixtureProject();
    const drafted = structuredClone(applied);
    drafted.name = 'Renamed';
    const json = fixtureJson(drafted);
    const a = getDraftProjectState(json, applied);
    const b = getDraftProjectState(json, applied);
    expect(a.kind).toBe(b.kind);
    if (a.kind === 'valid' && b.kind === 'valid') {
      expect(a.project.id).toBe(b.project.id);
      expect(a.project.name).toBe(b.project.name);
      expect(a.report.issues.length).toBe(b.report.issues.length);
    }
  });
});

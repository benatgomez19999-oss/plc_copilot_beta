import { describe, expect, it } from 'vitest';
import fixture from '../src/fixtures/weldline.json';
import { AlarmSchema, ProjectSchema } from '../src/schemas/index.js';

describe('ProjectSchema', () => {
  it('parses the weldline fixture', () => {
    const parsed = ProjectSchema.parse(fixture);
    expect(parsed.pir_version).toBe('0.1.0');
    expect(parsed.machines).toHaveLength(1);
    expect(parsed.machines[0]!.stations.length).toBeGreaterThanOrEqual(1);
  });

  it('applies ack_required default = true', () => {
    const parsed = AlarmSchema.parse({
      id: 'al_sample',
      severity: 'warn',
      text_i18n: { en: 'Sample' },
    });
    expect(parsed.ack_required).toBe(true);
  });

  it('rejects projects missing pir_version', () => {
    const bad = structuredClone(fixture) as Record<string, unknown>;
    delete bad['pir_version'];
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });

  it('rejects projects with more than one machine', () => {
    const bad = structuredClone(fixture) as { machines: unknown[] };
    const first = bad.machines[0];
    bad.machines = [first, first];
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });

  it('rejects ids not matching the id regex', () => {
    const bad = structuredClone(fixture) as { id: string };
    bad.id = 'Invalid ID!';
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });
});

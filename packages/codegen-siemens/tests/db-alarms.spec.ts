import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  DB_ALARMS_PATH,
  generateDbAlarms,
} from '../src/generators/db-alarms.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('generateDbAlarms — v2 contract', () => {
  it('emits a DATA_BLOCK with ack_all + set_/active_ per alarm', () => {
    const a = generateDbAlarms(clone());
    expect(a).not.toBeNull();
    const c = a!.content;
    expect(a!.path).toBe(DB_ALARMS_PATH);
    expect(a!.kind).toBe('scl');
    expect(c).toContain('DATA_BLOCK "DB_Alarms"');
    expect(c).toContain('ack_all : Bool;');
    expect(c).toContain('set_al_cyl_ext_timeout : Bool');
    expect(c).toContain('active_al_cyl_ext_timeout : Bool');
    expect(c).toContain('END_DATA_BLOCK');
  });

  it('set_ declaration precedes active_ declaration for each alarm', () => {
    const c = generateDbAlarms(clone())!.content;
    const setPos = c.indexOf('set_al_cyl_ext_timeout');
    const activePos = c.indexOf('active_al_cyl_ext_timeout');
    expect(setPos).toBeGreaterThan(-1);
    expect(activePos).toBeGreaterThan(setPos);
  });

  it('emits severity + english text on the set_ comment', () => {
    const c = generateDbAlarms(clone())!.content;
    expect(c).toMatch(
      /set_al_cyl_ext_timeout\s*:\s*Bool;\s*\/\/\s*\[warn\]/,
    );
    expect(c).toMatch(
      /set_al_estop_active\s*:\s*Bool;\s*\/\/\s*\[critical\]/,
    );
  });

  it('orders alarms alphabetically by id', () => {
    const c = generateDbAlarms(clone())!.content;
    const extPos = c.indexOf('set_al_cyl_ext_timeout');
    const retPos = c.indexOf('set_al_cyl_ret_timeout');
    const estopPos = c.indexOf('set_al_estop_active');
    expect(extPos).toBeLessThan(retPos);
    expect(retPos).toBeLessThan(estopPos);
  });

  it('returns null when the machine has no alarms', () => {
    const p = clone();
    p.machines[0]!.alarms = [];
    expect(generateDbAlarms(p)).toBeNull();
  });

  it('is deterministic across calls', () => {
    const a = generateDbAlarms(clone())!.content;
    const b = generateDbAlarms(clone())!.content;
    expect(a).toBe(b);
  });

  it('strips CR/LF/TAB from alarm text to keep comments single-line', () => {
    const p = clone();
    p.machines[0]!.alarms[0]!.text_i18n = { en: 'line 1\nline 2\tend' };
    const c = generateDbAlarms(p)!.content;
    const match = c.match(
      /set_al_cyl_ext_timeout\s*:\s*Bool;\s*\/\/\s*(.*)/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/\r|\n|\t/);
  });
});

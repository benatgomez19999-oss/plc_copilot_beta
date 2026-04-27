import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateDbAlarms } from '../src/generators/db-alarms.js';
import { generateFbAlarmsIR } from '../src/generators/fb-alarms.js';
import { renderFunctionBlock } from '../src/compiler/renderers/scl.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('DB_Alarms v2 — structure', () => {
  const a = generateDbAlarms(clone())!;

  it('declares ack_all as a global Bool', () => {
    expect(a.content).toContain('ack_all : Bool;');
  });

  it('declares a set_<id> and active_<id> pair per alarm', () => {
    const c = a.content;
    expect(c).toContain('set_al_cyl_ext_timeout : Bool');
    expect(c).toContain('active_al_cyl_ext_timeout : Bool');
    expect(c).toContain('set_al_cyl_ret_timeout : Bool');
    expect(c).toContain('active_al_cyl_ret_timeout : Bool');
    expect(c).toContain('set_al_estop_active : Bool');
    expect(c).toContain('active_al_estop_active : Bool');
  });

  it('preserves severity + english text in the set_ comment', () => {
    const c = a.content;
    expect(c).toMatch(/set_al_cyl_ext_timeout\s*:\s*Bool;\s*\/\/\s*\[warn\]/);
    expect(c).toMatch(/set_al_estop_active\s*:\s*Bool;\s*\/\/\s*\[critical\]/);
  });

  it('is deterministic across calls', () => {
    const b = generateDbAlarms(clone())!;
    expect(a.content).toBe(b.content);
  });
});

describe('FB_Alarms — set/ack lowering', () => {
  const fb = generateFbAlarmsIR(clone())!;
  const scl = renderFunctionBlock(fb);

  it('emits a FUNCTION_BLOCK with no VAR sections', () => {
    expect(scl).toContain('FUNCTION_BLOCK "FB_Alarms"');
    expect(scl).not.toContain('VAR_INPUT');
    expect(scl).not.toContain('VAR_OUTPUT');
    expect(scl).toContain('END_FUNCTION_BLOCK');
  });

  it('latches set_<id> into active_<id> in pass 1', () => {
    expect(scl).toMatch(
      /IF "DB_Alarms"\.set_al_cyl_ext_timeout THEN[\s\S]*?"DB_Alarms"\.active_al_cyl_ext_timeout := TRUE;/,
    );
    expect(scl).toMatch(
      /IF "DB_Alarms"\.set_al_estop_active THEN[\s\S]*?"DB_Alarms"\.active_al_estop_active := TRUE;/,
    );
  });

  it('clears active_<id> when ack_all AND NOT set_<id> in pass 2', () => {
    expect(scl).toMatch(
      /IF "DB_Alarms"\.ack_all AND NOT "DB_Alarms"\.set_al_cyl_ext_timeout THEN[\s\S]*?"DB_Alarms"\.active_al_cyl_ext_timeout := FALSE;/,
    );
  });

  it('emits an alphabetically ordered alarm sweep', () => {
    const extPos = scl.indexOf('set_al_cyl_ext_timeout');
    const retPos = scl.indexOf('set_al_cyl_ret_timeout');
    const estopPos = scl.indexOf('set_al_estop_active');
    expect(extPos).toBeLessThan(retPos);
    expect(retPos).toBeLessThan(estopPos);
  });

  it('is deterministic across calls', () => {
    const a = renderFunctionBlock(generateFbAlarmsIR(clone())!);
    const b = renderFunctionBlock(generateFbAlarmsIR(clone())!);
    expect(a).toBe(b);
  });

  it('returns null when the machine has no alarms', () => {
    const p = clone();
    p.machines[0]!.alarms = [];
    expect(generateFbAlarmsIR(p)).toBeNull();
  });
});

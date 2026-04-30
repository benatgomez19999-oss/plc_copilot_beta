// Sprint 87A — `valve_onoff` is the first equipment kind whose
// vendor-target support diverges by readiness. CODESYS ships v0
// support; Siemens and Rockwell still reject the kind via
// `READINESS_FAILED`.
//
// These tests build a small synthetic project (one machine, one
// station, one valve) and exercise `generateCodesysProject`. The
// existing weldline fixture covers the cylinder/motor path; this
// spec lives next to it so the new artifact shape is pinned.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateCodesysProject } from '../src/index.js';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

function valveProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_valve87a',
    name: 'Sprint 87A valve_onoff smoke',
    description: 'Single-station valve_onoff project for CODESYS v0 support.',
    machines: [
      {
        id: 'mch_v',
        name: 'Valve machine',
        stations: [
          {
            id: 'st_dose',
            name: 'Dose Station',
            equipment: [
              {
                id: 'v01',
                name: 'Dose valve',
                type: 'valve_onoff',
                code_symbol: 'V01',
                io_bindings: {
                  solenoid_out: 'io_v01_sol',
                },
              },
            ],
            sequence: {
              states: [
                {
                  id: 'st_idle',
                  name: 'Idle',
                  kind: 'initial',
                },
                {
                  id: 'st_open',
                  name: 'Dosing',
                  kind: 'normal',
                  activity: { activate: ['v01.open'] },
                },
              ],
              transitions: [
                {
                  id: 't_start',
                  from: 'st_idle',
                  to: 'st_open',
                  trigger: 'rising(start_button)',
                  priority: 1,
                },
                {
                  id: 't_done',
                  from: 'st_open',
                  to: 'st_idle',
                  trigger: 'falling(start_button)',
                  priority: 1,
                },
              ],
            },
          },
        ],
        io: [
          {
            id: 'io_v01_sol',
            name: 'V01 solenoid',
            direction: 'out',
            data_type: 'bool',
            address: { memory_area: 'Q', byte: 0, bit: 0 },
          },
          {
            id: 'start_button',
            name: 'Start button',
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

describe('generateCodesysProject — Sprint 87A valve_onoff', () => {
  const artifacts = generateCodesysProject(valveProject(), CLOCK);

  it('1. preflight passes — no READINESS_FAILED throw on a valve_onoff project', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('2. emits DUT_ValveOnoff with the documented field set', () => {
    const dut = artifacts.find((a) => a.path.endsWith('DUT_ValveOnoff.st'));
    expect(dut).toBeDefined();
    expect(dut!.kind).toBe('st');
    expect(dut!.content).toContain('TYPE DUT_ValveOnoff :');
    expect(dut!.content).toContain('cmd_open : BOOL;');
    expect(dut!.content).toContain('fault : BOOL;');
    expect(dut!.content).toContain('END_STRUCT');
    expect(dut!.content).toContain('END_TYPE');
    // The minimal v0 shape — keep it pinned.
    expect(dut!.content).not.toContain('cmd_close');
    expect(dut!.content).not.toContain('busy');
    expect(dut!.content).not.toContain('fb_open');
  });

  it('3. station FB body wires open_cmd to the solenoid output', () => {
    const fb = artifacts.find((a) => a.path.endsWith('FB_StDose.st'));
    expect(fb).toBeDefined();
    // The lowering emits a comment + assignment using the
    // canonical command-var name (commandVarName).
    expect(fb!.content).toContain('v01 (valve_onoff): open_cmd -> solenoid_out');
    expect(fb!.content).toContain('v01_open_cmd');
  });

  it('4. manifest records the v01 valve as a known equipment instance', () => {
    const manifest = artifacts.find((a) => a.path.endsWith('manifest.json'));
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe('json');
    const parsed = JSON.parse(manifest!.content);
    // Compiler diagnostics should have no UNSUPPORTED_EQUIPMENT /
    // READINESS_* errors for the valve.
    const diags: Array<{ code: string }> = parsed.compiler_diagnostics ?? [];
    expect(
      diags.every(
        (d) =>
          d.code !== 'UNSUPPORTED_EQUIPMENT' &&
          d.code !== 'UNSUPPORTED_ACTIVITY',
      ),
    ).toBe(true);
  });

  it('5. generation is deterministic across runs', () => {
    const a = generateCodesysProject(valveProject(), CLOCK);
    const b = generateCodesysProject(valveProject(), CLOCK);
    expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
    expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
  });
});

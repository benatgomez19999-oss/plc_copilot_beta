// Sprint 87A — Rockwell rejects `valve_onoff` via readiness so the
// per-target capability split stays load-bearing.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateRockwellProject } from '../src/index.js';

function valveProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_valve87a_rockwell_reject',
    name: 'Sprint 87A valve_onoff Rockwell rejection',
    description: 'Synthetic project to assert Rockwell still rejects valve_onoff.',
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
                io_bindings: { solenoid_out: 'io_v01_sol' },
              },
            ],
            sequence: {
              states: [
                { id: 'st_idle', name: 'Idle', kind: 'initial' },
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

describe('generateRockwellProject — Sprint 87A rejects valve_onoff', () => {
  it('1. throws CodegenError(READINESS_FAILED) before compileProject runs', () => {
    let caught: { name?: string; code?: string; message?: string } | undefined;
    try {
      generateRockwellProject(valveProject());
    } catch (e) {
      caught = e as { name: string; code: string; message: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.name).toBe('CodegenError');
    expect(caught?.code).toBe('READINESS_FAILED');
    expect(caught?.message).toContain('rockwell');
    expect(caught?.message).toContain(
      'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
    );
    expect(caught?.message).toContain('valve_onoff');
  });
});

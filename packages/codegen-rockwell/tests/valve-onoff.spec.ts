// Sprint 88C — Rockwell supports `valve_onoff` after the Logix
// renderer audit confirmed it is structurally agnostic
// (`buildEquipmentTypesIR` walks core's `FIELDS` table;
// `wireValveOnoff` produces standard StmtIR; the Rockwell ST
// renderer iterates IR nodes without per-kind logic; no
// `UDT_NAMES` map exists — canonical names flow through
// `core.canonicalTypeName`).
//
// Sprint 87A's CODESYS support and Sprint 87C's Siemens support
// stay intact. Rockwell now joins them on the v0
// `valve_onoff` baseline; equipment kinds outside the core set
// (e.g. `motor_vfd_simple`) still fail readiness on every
// target.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateRockwellProject } from '../src/index.js';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

function valveProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_valve88c',
    name: 'Sprint 88C valve_onoff smoke',
    description:
      'Single-station valve_onoff project for Rockwell v0 support.',
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

describe('generateRockwellProject — Sprint 88C valve_onoff', () => {
  const artifacts = generateRockwellProject(valveProject(), CLOCK);

  it('1. preflight passes — no READINESS_FAILED throw on a valve_onoff project', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('2. emits UDT_ValveOnoff at rockwell/UDT_ValveOnoff.st with the documented field set', () => {
    const udt = artifacts.find(
      (a) => a.path === 'rockwell/UDT_ValveOnoff.st',
    );
    expect(udt).toBeDefined();
    expect(udt!.kind).toBe('st');
    expect(udt!.content).toContain('UDT_ValveOnoff');
    // The minimal v0 shape is shared with Siemens / CODESYS:
    // cmd_open BOOL + fault BOOL only.
    expect(udt!.content).toMatch(/cmd_open\s*:\s*BOOL/);
    expect(udt!.content).toMatch(/fault\s*:\s*BOOL/);
    expect(udt!.content).not.toContain('cmd_close');
    expect(udt!.content).not.toContain('fb_open');
    expect(udt!.content).not.toContain('busy');
  });

  it('3. station FB body wires open_cmd to the solenoid output (deterministic ST)', () => {
    const fb = artifacts.find((a) => a.path === 'rockwell/FB_StDose.st');
    expect(fb).toBeDefined();
    // The vendor-neutral lowering emits a comment + assignment
    // via `wireValveOnoff`; the Rockwell ST renderer turns
    // local refs and IO refs into the same canonical names
    // operators see in Siemens / CODESYS output.
    expect(fb!.content).toContain('v01_open_cmd');
    expect(fb!.content).toMatch(
      /io_v01_sol\s*:=\s*v01_open_cmd/,
    );
    // The lowering comment carries the equipment id + kind for
    // an auditable breadcrumb.
    expect(fb!.content).toContain('v01 (valve_onoff)');
  });

  it('4. no close output / no feedback / no fault latching is synthesised', () => {
    const fb = artifacts.find((a) => a.path === 'rockwell/FB_StDose.st');
    expect(fb).toBeDefined();
    expect(fb!.content).not.toContain('v01_close_cmd');
    expect(fb!.content).not.toContain('v01_close_out');
    expect(fb!.content).not.toContain('v01_fb_');
    // The DUT exposes a `fault` bit but the lowering never
    // drives it — alarm/interlock layers do that.
    expect(fb!.content).not.toMatch(/v01[._]fault\s*:=/);
  });

  it('5. missing solenoid_out binding still surfaces as UNBOUND_ROLE', () => {
    const p = valveProject();
    p.machines[0].stations[0].equipment[0].io_bindings = {} as Record<
      string,
      string
    >;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateRockwellProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_ROLE');
    expect(caught?.symbol).toContain('solenoid_out');
  });

  it('6. manifest declares the project clean of UNSUPPORTED_* / READINESS_FAILED diagnostics', () => {
    const manifest = artifacts.find(
      (a) => a.path === 'rockwell/manifest.json',
    );
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe('json');
    const parsed = JSON.parse(manifest!.content);
    const diags: Array<{ code: string }> =
      parsed.compiler_diagnostics ?? [];
    expect(
      diags.every(
        (d) =>
          d.code !== 'UNSUPPORTED_EQUIPMENT' &&
          d.code !== 'UNSUPPORTED_ACTIVITY' &&
          d.code !== 'READINESS_FAILED',
      ),
    ).toBe(true);
    // Rockwell still flags itself as experimental — keep the
    // existing global diagnostic intact (Sprint 87A behaviour).
    expect(diags.some((d) => d.code === 'ROCKWELL_EXPERIMENTAL_BACKEND')).toBe(
      true,
    );
  });

  it('7. artifact list contains exactly one UDT_ValveOnoff and no duplicates', () => {
    const udtPaths = artifacts
      .filter((a) => a.path.includes('UDT_ValveOnoff'))
      .map((a) => a.path);
    expect(udtPaths).toEqual(['rockwell/UDT_ValveOnoff.st']);
    const allPaths = artifacts.map((a) => a.path);
    const uniquePaths = Array.from(new Set(allPaths));
    expect(allPaths.length).toBe(uniquePaths.length);
  });

  it('8. generation is deterministic across runs', () => {
    const a = generateRockwellProject(valveProject(), CLOCK);
    const b = generateRockwellProject(valveProject(), CLOCK);
    expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
    expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
  });
});

// Sprint 87C — Siemens supports `valve_onoff` after the SCL renderer
// audit confirmed it is structurally agnostic (`buildEquipmentTypesIR`
// walks core's FIELDS table; `wireValveOnoff` produces standard
// StmtIR; `renderTypeArtifactSiemens` iterates IR fields without
// per-kind logic). Sprint 87A's CODESYS support stays intact;
// Rockwell continues to reject the kind via the readiness pass.
//
// These tests build a small synthetic project (one machine, one
// station, one valve) and exercise `generateSiemensProject`. The
// existing weldline fixture covers the cylinder/motor path; this
// spec lives next to it so the new artifact shape is pinned.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateSiemensProject } from '../src/index.js';
import { udtName } from '../src/naming.js';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

function valveProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_valve87c',
    name: 'Sprint 87C valve_onoff smoke',
    description: 'Single-station valve_onoff project for Siemens v0 support.',
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

describe('generateSiemensProject — Sprint 87C valve_onoff', () => {
  const artifacts = generateSiemensProject(valveProject(), CLOCK);

  it('1. preflight passes — no READINESS_FAILED throw on a valve_onoff project', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('2. emits UDT_ValveOnoff at siemens/UDT_ValveOnoff.scl with the documented field set', () => {
    const udt = artifacts.find(
      (a) => a.path === 'siemens/UDT_ValveOnoff.scl',
    );
    expect(udt).toBeDefined();
    expect(udt!.kind).toBe('scl');
    expect(udt!.content).toContain('TYPE "UDT_ValveOnoff"');
    expect(udt!.content).toContain('cmd_open : Bool;');
    expect(udt!.content).toContain('fault : Bool;');
    expect(udt!.content).toContain('END_STRUCT;');
    expect(udt!.content).toContain('END_TYPE');
    // Pin the minimal v0 shape — no close output, no feedback,
    // no busy bit.
    expect(udt!.content).not.toContain('cmd_close');
    expect(udt!.content).not.toContain('fb_open');
    expect(udt!.content).not.toContain('busy');
  });

  it('3. station FB body wires open_cmd to the solenoid output (deterministic SCL)', () => {
    const fb = artifacts.find((a) => a.path === 'siemens/FB_StDose.scl');
    expect(fb).toBeDefined();
    // Vendor-neutral lowering emits a comment + assignment via
    // `wireValveOnoff`; the SCL renderer turns local refs into `#`-
    // prefixed names and IO refs into `"…"` names.
    expect(fb!.content).toContain('#v01_open_cmd');
    expect(fb!.content).toMatch(
      /"io_v01_sol"\s*:=\s*#v01_open_cmd/,
    );
    // The lowering comment is part of the IR and survives rendering
    // — gives the operator a canonical breadcrumb back to the
    // equipment id and kind.
    expect(fb!.content).toContain('v01 (valve_onoff)');
  });

  it('4. udtName public helper returns the canonical name for valve_onoff', () => {
    expect(udtName('valve_onoff')).toBe('UDT_ValveOnoff');
  });

  it('5. manifest declares the project clean of UNSUPPORTED_* compiler diagnostics', () => {
    const manifest = artifacts.find((a) => a.path === 'siemens/manifest.json');
    expect(manifest).toBeDefined();
    expect(manifest!.kind).toBe('json');
    const parsed = JSON.parse(manifest!.content);
    const diags: Array<{ code: string }> =
      parsed.compilerDiagnostics ?? parsed.compiler_diagnostics ?? [];
    expect(
      diags.every(
        (d) =>
          d.code !== 'UNSUPPORTED_EQUIPMENT' &&
          d.code !== 'UNSUPPORTED_ACTIVITY' &&
          d.code !== 'READINESS_FAILED',
      ),
    ).toBe(true);
  });

  it('6. generation is deterministic across runs', () => {
    const a = generateSiemensProject(valveProject(), CLOCK);
    const b = generateSiemensProject(valveProject(), CLOCK);
    expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
    expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
  });

  it('7. missing solenoid_out binding still surfaces as UNBOUND_ROLE (Sprint 76 contract)', () => {
    const p = valveProject();
    p.machines[0].stations[0].equipment[0].io_bindings = {} as Record<
      string,
      string
    >;
    let caught: { code?: string; symbol?: string } | undefined;
    try {
      generateSiemensProject(p, CLOCK);
    } catch (e) {
      caught = e as { code: string; symbol: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('UNBOUND_ROLE');
    expect(caught?.symbol).toContain('solenoid_out');
  });
});

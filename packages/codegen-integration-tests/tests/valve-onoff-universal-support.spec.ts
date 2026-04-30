// Sprint 88D — cross-renderer integration tests for `valve_onoff`.
//
// Sprints 87A (CODESYS), 87C (Siemens) and 88C (Rockwell) each
// audited their backend renderer and widened the readiness
// capability table to accept `valve_onoff`. Per-package specs pin
// the per-target shape; this file pins the *parity* across all
// three so future renderer drift surfaces immediately at
// integration scope.
//
// Contract under test (cross-target):
//   - readiness/preflight passes for all three vendors,
//   - each backend emits a type artifact for `valve_onoff`
//     containing the minimal v0 field set (`cmd_open`, `fault`),
//     and *only* that minimal set,
//   - each backend wires the open command into the bound
//     solenoid output (per-target lexical conventions),
//   - no backend synthesises a close output, position feedback,
//     busy/done flags, or fault latching,
//   - manifests carry no `UNSUPPORTED_*` / `READINESS_FAILED`
//     diagnostics for `valve_onoff`,
//   - `motor_vfd_simple` (still outside `CORE_SUPPORTED_EQUIPMENT`)
//     remains blocked on every vendor target.
//
// This is a regression / contract spec. It must not introduce new
// production capabilities; if a test fails the response is to
// either (a) fix the regression in the renderer/lowering, or (b)
// document the divergence and tighten the per-target spec —
// never to relax the parity bar.

import { describe, expect, it } from 'vitest';
import type { Project } from '@plccopilot/pir';

import { generateCodesysProject } from '@plccopilot/codegen-codesys';
import { generateSiemensProject } from '@plccopilot/codegen-siemens';
import { generateRockwellProject } from '@plccopilot/codegen-rockwell';
import { CodegenError, runTargetPreflight } from '@plccopilot/codegen-core';

const CLOCK = { manifest: { generatedAt: '2026-04-30T00:00:00Z' } };

// ---------------------------------------------------------------------------
// Fixture — single-station, single-valve PIR. Matches the shape used by the
// per-package valve-onoff specs so any per-target invariant they pin holds
// here too. Returned fresh per call (no shared mutable state).
// ---------------------------------------------------------------------------

function valveProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_valve88d',
    name: 'Sprint 88D valve_onoff cross-renderer fixture',
    description:
      'Single-station valve_onoff project shared by CODESYS / Siemens / Rockwell integration tests.',
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

// ---------------------------------------------------------------------------
// Per-target metadata. Each target produces the same logical artifact set
// (type artifact + station FB) under different lexical conventions.
// ---------------------------------------------------------------------------

type Target = 'codesys' | 'siemens' | 'rockwell';

interface TargetSpec {
  target: Target;
  generate: (p: Project, opts: typeof CLOCK) => Array<{
    path: string;
    kind: string;
    content: string;
  }>;
  typeArtifactPath: string;
  fbArtifactPath: string;
  // The expected lexical assignment shape for "open command -> solenoid out".
  assignRe: RegExp;
  // The lexical convention used for the bool field on this backend.
  // CODESYS / Rockwell render `BOOL`, Siemens renders `Bool`.
  boolToken: string;
}

const TARGETS: TargetSpec[] = [
  {
    target: 'codesys',
    generate: generateCodesysProject as TargetSpec['generate'],
    typeArtifactPath: 'codesys/DUT_ValveOnoff.st',
    fbArtifactPath: 'codesys/FB_StDose.st',
    assignRe: /io_v01_sol\s*:=\s*v01_open_cmd/,
    boolToken: 'BOOL',
  },
  {
    target: 'siemens',
    generate: generateSiemensProject as TargetSpec['generate'],
    typeArtifactPath: 'siemens/UDT_ValveOnoff.scl',
    fbArtifactPath: 'siemens/FB_StDose.scl',
    assignRe: /"io_v01_sol"\s*:=\s*#v01_open_cmd/,
    boolToken: 'Bool',
  },
  {
    target: 'rockwell',
    generate: generateRockwellProject as TargetSpec['generate'],
    typeArtifactPath: 'rockwell/UDT_ValveOnoff.st',
    fbArtifactPath: 'rockwell/FB_StDose.st',
    assignRe: /io_v01_sol\s*:=\s*v01_open_cmd/,
    boolToken: 'BOOL',
  },
];

// Strip block comments — `(* ... *)` (CODESYS / Rockwell ST) and `// ...` line
// comments (Siemens SCL) — before scanning for forbidden symbol fragments.
// Lowering breadcrumbs legitimately mention `v01 (valve_onoff)`; we don't
// want those quoted strings to register as a fault-latch / close-output
// false positive.
function stripComments(content: string): string {
  return content
    .replace(/\(\*[\s\S]*?\*\)/g, '') // ST block comments
    .replace(/\/\/[^\n]*/g, ''); // SCL/ST line comments
}

// =============================================================================
// 1. Generates valve_onoff for all supported vendor targets
// =============================================================================

describe('Sprint 88D — valve_onoff universal support (integration)', () => {
  describe('1. all three vendor targets generate non-empty artifact sets', () => {
    for (const t of TARGETS) {
      it(`${t.target} → produces a non-empty artifact list with the expected type + FB paths`, () => {
        const artifacts = t.generate(valveProject(), CLOCK);
        expect(artifacts.length).toBeGreaterThan(0);
        expect(artifacts.some((a) => a.path === t.typeArtifactPath)).toBe(true);
        expect(artifacts.some((a) => a.path === t.fbArtifactPath)).toBe(true);
      });
    }
  });

  // =============================================================================
  // 2. Equivalent UDT/DUT field shape across targets
  // =============================================================================

  describe('2. type artifacts carry the same minimal v0 field shape across targets', () => {
    for (const t of TARGETS) {
      it(`${t.target} → type artifact contains cmd_open + fault and nothing else from the v0+1 set`, () => {
        const artifacts = t.generate(valveProject(), CLOCK);
        const ty = artifacts.find((a) => a.path === t.typeArtifactPath);
        expect(ty).toBeDefined();
        expect(ty!.content).toMatch(
          new RegExp(`cmd_open\\s*:\\s*${t.boolToken}`),
        );
        expect(ty!.content).toMatch(
          new RegExp(`fault\\s*:\\s*${t.boolToken}`),
        );
        // The minimal v0 shape — must be pinned identically on every backend.
        // These are the fields a future Sprint NX widening would add; until
        // then, no backend is allowed to ship them ahead of the contract.
        expect(ty!.content).not.toContain('cmd_close');
        expect(ty!.content).not.toContain('fb_open');
        expect(ty!.content).not.toContain('fb_closed');
        expect(ty!.content).not.toContain('position');
        expect(ty!.content).not.toMatch(/\bbusy\s*:/);
        expect(ty!.content).not.toMatch(/\bdone\s*:/);
      });
    }
  });

  // =============================================================================
  // 3. Wires open command to solenoid output across targets
  // =============================================================================

  describe('3. station FBs wire the open command to the solenoid output', () => {
    for (const t of TARGETS) {
      it(`${t.target} → station FB contains the open_cmd → io_v01_sol assignment`, () => {
        const artifacts = t.generate(valveProject(), CLOCK);
        const fb = artifacts.find((a) => a.path === t.fbArtifactPath);
        expect(fb).toBeDefined();
        expect(fb!.content).toMatch(t.assignRe);
        // Lowering breadcrumb is part of the IR, surfaces verbatim
        // on every backend.
        expect(fb!.content).toContain('v01 (valve_onoff)');
      });
    }
  });

  // =============================================================================
  // 4. Readiness green for all production targets
  // =============================================================================

  describe('4. runTargetPreflight returns clean for valve_onoff on every vendor target', () => {
    for (const t of TARGETS) {
      it(`${t.target} → no READINESS_FAILED throw, no blocking diagnostics`, () => {
        const result = runTargetPreflight(valveProject(), t.target);
        expect(result.hasBlockingErrors).toBe(false);
        expect(
          result.diagnostics.some(
            (d) =>
              d.severity === 'error' &&
              d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
          ),
        ).toBe(false);
      });
    }
  });

  // =============================================================================
  // 5. motor_vfd_simple still blocked across targets
  // =============================================================================

  describe('5. motor_vfd_simple stays blocked on every vendor target (no accidental opening)', () => {
    for (const t of TARGETS) {
      it(`${t.target} → runTargetPreflight throws READINESS_FAILED with UNSUPPORTED_EQUIPMENT_FOR_TARGET`, () => {
        const p = valveProject();
        (p.machines[0].stations[0].equipment[0].type as string) =
          'motor_vfd_simple';
        let caught: CodegenError | undefined;
        try {
          runTargetPreflight(p, t.target);
        } catch (e) {
          caught = e as CodegenError;
        }
        expect(caught).toBeDefined();
        expect(caught?.code).toBe('READINESS_FAILED');
        const cause = caught?.cause as
          | { diagnostics: Array<{ code: string }> }
          | undefined;
        expect(
          cause?.diagnostics?.some(
            (d) => d.code === 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
          ),
        ).toBe(true);
      });
    }
  });

  // =============================================================================
  // 6. No additional valve signals are synthesised
  // =============================================================================

  describe('6. no backend synthesises additional valve signals beyond the v0 contract', () => {
    for (const t of TARGETS) {
      it(`${t.target} → no close output / fb_ feedback / busy / done / second coil in code artifacts`, () => {
        const artifacts = t.generate(valveProject(), CLOCK);
        const codeArtifacts = artifacts.filter(
          (a) => a.kind === 'st' || a.kind === 'scl',
        );
        for (const a of codeArtifacts) {
          const stripped = stripComments(a.content);
          // Forbidden synthesised signals — these would indicate the
          // lowering or renderer drifted past the v0 contract.
          expect(stripped).not.toContain('v01_close_cmd');
          expect(stripped).not.toContain('v01_close_out');
          expect(stripped).not.toContain('v01_fb_open');
          expect(stripped).not.toContain('v01_fb_closed');
          expect(stripped).not.toContain('v01_busy');
          expect(stripped).not.toContain('v01_done');
          expect(stripped).not.toContain('v01_position');
          // The DUT/UDT exposes a `fault` bit but no backend should
          // *drive* it (alarm/interlock layers do). A bare `v01_fault :=`
          // assignment would mean the lowering started latching on its own.
          expect(stripped).not.toMatch(/v01[._]fault\s*:=/);
        }
      });
    }
  });

  // =============================================================================
  // 7. Manifests carry expected diagnostics; no unsupported / readiness errors
  // =============================================================================

  describe('7. manifests are clean of unsupported / readiness errors', () => {
    for (const t of TARGETS) {
      it(`${t.target} → manifest has no UNSUPPORTED_* / READINESS_FAILED for valve_onoff`, () => {
        const artifacts = t.generate(valveProject(), CLOCK);
        const manifest = artifacts.find(
          (a) => a.path === `${t.target}/manifest.json`,
        );
        expect(manifest).toBeDefined();
        const parsed = JSON.parse(manifest!.content);
        const diags: Array<{ code: string }> =
          parsed.compiler_diagnostics ?? parsed.compilerDiagnostics ?? [];
        expect(
          diags.every(
            (d) =>
              d.code !== 'UNSUPPORTED_EQUIPMENT' &&
              d.code !== 'UNSUPPORTED_ACTIVITY' &&
              d.code !== 'READINESS_FAILED' &&
              d.code !== 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
          ),
        ).toBe(true);
        if (t.target === 'rockwell') {
          // Rockwell still flags itself experimental — keep the legacy
          // global diagnostic intact (Sprint 87A behaviour).
          expect(
            diags.some((d) => d.code === 'ROCKWELL_EXPERIMENTAL_BACKEND'),
          ).toBe(true);
        }
      });
    }
  });

  // =============================================================================
  // 8. Determinism + cross-target isolation
  // =============================================================================

  it('8. all three backends are deterministic across two runs of the valve_onoff fixture', () => {
    for (const t of TARGETS) {
      const a = t.generate(valveProject(), CLOCK);
      const b = t.generate(valveProject(), CLOCK);
      expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
      expect(a.map((art) => art.content)).toEqual(b.map((art) => art.content));
    }
  });
});

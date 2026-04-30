// Sprint 88K — cross-renderer integration tests for `motor_vfd_simple`.
//
// Sprints 88H (CODESYS), 88I (Siemens) and 88J (Rockwell) each
// audited their backend renderer and widened the readiness
// capability table to accept `motor_vfd_simple`. Per-package
// specs pin the per-target shape; this file pins the *parity*
// across all three so future renderer drift surfaces immediately
// at integration scope. Mirror of Sprint 88D for valve_onoff.
//
// Contract under test (cross-target):
//   - readiness/preflight passes for all three vendors,
//   - each backend emits a type artifact for `motor_vfd_simple`
//     containing exactly the v0 field set
//     (`cmd_run`, `speed_setpoint`, `fault`),
//   - each backend wires the run command into the bound boolean
//     output (per-target lexical conventions),
//   - each backend wires the bound `Parameter` into the bound
//     numeric output — never a synthesised literal,
//   - no backend synthesises close output, position feedback,
//     busy/done, fault latching, ramp, reset, fwd/rev, jog, or
//     permissive logic,
//   - manifests carry no `UNSUPPORTED_*` / `READINESS_FAILED`
//     diagnostics for `motor_vfd_simple`; Rockwell still carries
//     `ROCKWELL_EXPERIMENTAL_BACKEND`,
//   - generation is deterministic across two runs,
//   - `pneumatic_cylinder_1pos` (still outside
//     `CORE_SUPPORTED_EQUIPMENT`) remains blocked on every
//     vendor target.
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
// Fixture — single-station, single-VFD-motor PIR with one machine-level
// numeric Parameter wired through `io_setpoint_bindings.speed_setpoint_out`.
// Matches the shape used by the per-package motor-vfd-simple specs so any
// per-target invariant they pin holds here too. Returned fresh per call
// (no shared mutable state).
// ---------------------------------------------------------------------------

function vfdProject(): Project {
  return {
    pir_version: '0.1.0',
    id: 'prj_vfd88k',
    name: 'Sprint 88K motor_vfd_simple cross-renderer fixture',
    description:
      'Single-station VFD-driven motor shared by CODESYS / Siemens / Rockwell integration tests.',
    machines: [
      {
        id: 'mch_v',
        name: 'VFD machine',
        stations: [
          {
            id: 'st_run',
            name: 'Run Station',
            equipment: [
              {
                id: 'mot01',
                name: 'Conveyor motor',
                type: 'motor_vfd_simple',
                code_symbol: 'M01',
                io_bindings: {
                  run_out: 'io_m01_run',
                  speed_setpoint_out: 'io_m01_speed_aw',
                },
                io_setpoint_bindings: {
                  speed_setpoint_out: 'p_m01_speed',
                },
              },
            ],
            sequence: {
              states: [
                { id: 'st_idle', name: 'Idle', kind: 'initial' },
                {
                  id: 'st_running',
                  name: 'Running',
                  kind: 'normal',
                  activity: { activate: ['mot01.run'] },
                },
              ],
              transitions: [
                {
                  id: 't_start',
                  from: 'st_idle',
                  to: 'st_running',
                  trigger: 'rising(start_button)',
                  priority: 1,
                },
                {
                  id: 't_stop',
                  from: 'st_running',
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
            id: 'io_m01_run',
            name: 'M01 run',
            direction: 'out',
            data_type: 'bool',
            address: { memory_area: 'Q', byte: 0, bit: 0 },
          },
          {
            id: 'io_m01_speed_aw',
            name: 'M01 speed AW',
            direction: 'out',
            data_type: 'real',
            address: { memory_area: 'Q', byte: 100 },
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
        parameters: [
          {
            id: 'p_m01_speed',
            name: 'M01 speed setpoint',
            data_type: 'real',
            default: 50,
            min: 0,
            max: 100,
            unit: 'Hz',
          },
        ],
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
  generate: (
    p: Project,
    opts: typeof CLOCK,
  ) => Array<{ path: string; kind: string; content: string }>;
  typeArtifactPath: string;
  fbArtifactPath: string;
  manifestPath: string;
  // Lexical conventions per backend.
  boolToken: string; // CODESYS/Rockwell: `BOOL`, Siemens: `Bool`
  realToken: string; // CODESYS/Rockwell: `REAL`, Siemens: `Real`
  // run_out := <run command> assignment
  runAssignRe: RegExp;
  // speed_setpoint_out := <bound parameter> assignment
  setpointAssignRe: RegExp;
  // setpoint RHS as a literal — must NEVER match
  setpointLiteralRe: RegExp;
}

const TARGETS: TargetSpec[] = [
  {
    target: 'codesys',
    generate: generateCodesysProject as TargetSpec['generate'],
    typeArtifactPath: 'codesys/DUT_MotorVfdSimple.st',
    fbArtifactPath: 'codesys/FB_StRun.st',
    manifestPath: 'codesys/manifest.json',
    boolToken: 'BOOL',
    realToken: 'REAL',
    runAssignRe: /io_m01_run\s*:=\s*mot01_run_cmd/,
    setpointAssignRe: /io_m01_speed_aw\s*:=\s*p_m01_speed\s*;/,
    setpointLiteralRe:
      /io_m01_speed_aw\s*:=\s*(?:TRUE|FALSE|-?\d+(?:\.\d+)?)\s*;/,
  },
  {
    target: 'siemens',
    generate: generateSiemensProject as TargetSpec['generate'],
    typeArtifactPath: 'siemens/UDT_MotorVfdSimple.scl',
    fbArtifactPath: 'siemens/FB_StRun.scl',
    manifestPath: 'siemens/manifest.json',
    boolToken: 'Bool',
    realToken: 'Real',
    runAssignRe: /"io_m01_run"\s*:=\s*#mot01_run_cmd/,
    setpointAssignRe: /"io_m01_speed_aw"\s*:=\s*"p_m01_speed"/,
    setpointLiteralRe:
      /"io_m01_speed_aw"\s*:=\s*(?:TRUE|FALSE|-?\d+(?:\.\d+)?)\s*;/,
  },
  {
    target: 'rockwell',
    generate: generateRockwellProject as TargetSpec['generate'],
    typeArtifactPath: 'rockwell/UDT_MotorVfdSimple.st',
    fbArtifactPath: 'rockwell/FB_StRun.st',
    manifestPath: 'rockwell/manifest.json',
    boolToken: 'BOOL',
    realToken: 'REAL',
    runAssignRe: /io_m01_run\s*:=\s*mot01_run_cmd/,
    setpointAssignRe: /io_m01_speed_aw\s*:=\s*p_m01_speed\s*;/,
    setpointLiteralRe:
      /io_m01_speed_aw\s*:=\s*(?:TRUE|FALSE|-?\d+(?:\.\d+)?)\s*;/,
  },
];

// Strip block + line comments before scanning for forbidden symbol fragments.
// Lowering breadcrumbs legitimately mention `motor_vfd_simple` etc. inside
// `(* ... *)` (CODESYS / Rockwell ST) and `// ...` (Siemens SCL); we don't
// want those quoted strings to register as a synthesised-signal false positive.
function stripComments(content: string): string {
  return content
    .replace(/\(\*[\s\S]*?\*\)/g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// =============================================================================
// 1. Generation succeeds on every vendor target
// =============================================================================

describe('Sprint 88K — motor_vfd_simple universal support (integration)', () => {
  describe('1. all three vendor targets generate non-empty artifact sets', () => {
    for (const t of TARGETS) {
      it(`${t.target} → produces a non-empty artifact list with the expected type + FB paths`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        expect(artifacts.length).toBeGreaterThan(0);
        expect(artifacts.some((a) => a.path === t.typeArtifactPath)).toBe(
          true,
        );
        expect(artifacts.some((a) => a.path === t.fbArtifactPath)).toBe(true);
        expect(artifacts.some((a) => a.path === t.manifestPath)).toBe(true);
      });
    }
  });

  // =============================================================================
  // 2. Type artifact parity — exact field set across targets
  // =============================================================================

  describe('2. type artifacts carry the same v0 field shape across targets', () => {
    for (const t of TARGETS) {
      it(`${t.target} → type artifact contains cmd_run + speed_setpoint + fault and nothing else from the v0+1 set`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const ty = artifacts.find((a) => a.path === t.typeArtifactPath);
        expect(ty).toBeDefined();
        expect(ty!.content).toMatch(
          new RegExp(`cmd_run\\s*:\\s*${t.boolToken}`),
        );
        expect(ty!.content).toMatch(
          new RegExp(`speed_setpoint\\s*:\\s*${t.realToken}`),
        );
        expect(ty!.content).toMatch(
          new RegExp(`fault\\s*:\\s*${t.boolToken}`),
        );
        // v0 surface — none of these belong on the motor_vfd_simple
        // type artifact until a higher-fidelity equipment kind ships
        // them deliberately.
        for (const forbidden of [
          'cmd_open',
          'cmd_close',
          'fb_open',
          'fb_closed',
          'busy',
          'done',
          'position',
          'reset',
          'reverse',
          'jog',
          'permissive',
          'ramp',
        ]) {
          expect(ty!.content).not.toContain(forbidden);
        }
      });
    }
  });

  // =============================================================================
  // 3. Station FB assignment parity — run + parameter-sourced setpoint
  // =============================================================================

  describe('3. station FBs wire the run command into run_out', () => {
    for (const t of TARGETS) {
      it(`${t.target} → station FB contains the canonical run assignment`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const fb = artifacts.find((a) => a.path === t.fbArtifactPath);
        expect(fb).toBeDefined();
        expect(fb!.content).toMatch(t.runAssignRe);
      });
    }
  });

  describe('3b. station FBs wire the bound Parameter into speed_setpoint_out', () => {
    for (const t of TARGETS) {
      it(`${t.target} → station FB contains the parameter-sourced setpoint assignment`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const fb = artifacts.find((a) => a.path === t.fbArtifactPath);
        expect(fb).toBeDefined();
        expect(fb!.content).toMatch(t.setpointAssignRe);
      });
    }
  });

  describe('3c. setpoint RHS is the bound Parameter, NEVER a synthesised literal', () => {
    for (const t of TARGETS) {
      it(`${t.target} → no \`io_m01_speed_aw := <number>;\` and no \`:= TRUE/FALSE;\``, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const fb = artifacts.find((a) => a.path === t.fbArtifactPath);
        expect(fb).toBeDefined();
        expect(fb!.content).not.toMatch(t.setpointLiteralRe);
      });
    }
  });

  // =============================================================================
  // 4. Breadcrumb / lowering comment parity
  // =============================================================================

  describe('4. each backend preserves the deterministic lowering breadcrumbs', () => {
    for (const t of TARGETS) {
      it(`${t.target} → station FB contains the run + setpoint lowering breadcrumbs`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const fb = artifacts.find((a) => a.path === t.fbArtifactPath);
        expect(fb).toBeDefined();
        // The breadcrumb is part of the IR (emitted by
        // wireMotorVfdSimple in codegen-core) and survives every
        // backend's comment-rendering convention.
        expect(fb!.content).toContain(
          'mot01 (motor_vfd_simple): run_cmd -> run_out',
        );
        expect(fb!.content).toContain(
          'mot01 (motor_vfd_simple): p_m01_speed -> speed_setpoint_out',
        );
      });
    }
  });

  // =============================================================================
  // 5. No synthesised safety / control signals
  // =============================================================================

  describe('5. no backend synthesises close / fb_ / busy / done / position / reset / reverse / jog / permissive / ramp / fault-latch identifiers', () => {
    for (const t of TARGETS) {
      it(`${t.target} → code artifacts (st/scl) carry none of the forbidden equipment-signal identifiers`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const codeArtifacts = artifacts.filter(
          (a) => a.kind === 'st' || a.kind === 'scl',
        );
        for (const a of codeArtifacts) {
          const stripped = stripComments(a.content);
          for (const forbidden of [
            'mot01_close',
            'mot01_close_cmd',
            'mot01_close_out',
            'mot01_fb_open',
            'mot01_fb_closed',
            'mot01_busy',
            'mot01_done',
            'mot01_position',
            'mot01_reverse',
            'mot01_reset',
            'mot01_jog',
            'mot01_permissive',
            'mot01_ramp',
          ]) {
            expect(stripped).not.toContain(forbidden);
          }
          // The DUT/UDT exposes a `fault` bit but no backend should
          // *drive* it from the lowering. A bare `mot01.fault := …`
          // or `mot01_fault := …` would mean a fault-latch path
          // sneaked in. The declared field itself (e.g.
          // `fault : BOOL;`) is fine because `:=` is not adjacent.
          expect(stripped).not.toMatch(/mot01[._]fault\s*:=/);
        }
      });
    }
  });

  // =============================================================================
  // 6. Manifest cleanliness + Rockwell-experimental retention
  // =============================================================================

  describe('6. manifests are clean of unsupported / readiness errors', () => {
    for (const t of TARGETS) {
      it(`${t.target} → manifest carries no UNSUPPORTED_* / READINESS_FAILED for motor_vfd_simple`, () => {
        const artifacts = t.generate(vfdProject(), CLOCK);
        const manifest = artifacts.find((a) => a.path === t.manifestPath);
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
          // Rockwell still flags itself experimental — the legacy
          // global diagnostic must survive Sprint 88J's widening.
          expect(
            diags.some((d) => d.code === 'ROCKWELL_EXPERIMENTAL_BACKEND'),
          ).toBe(true);
        }
      });
    }
  });

  // =============================================================================
  // 7. Preflight parity
  // =============================================================================

  describe('7. runTargetPreflight returns clean for motor_vfd_simple on every vendor target', () => {
    for (const t of TARGETS) {
      it(`${t.target} → no READINESS_FAILED throw, no blocking diagnostics`, () => {
        const result = runTargetPreflight(vfdProject(), t.target);
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

  describe('7b. pneumatic_cylinder_1pos still throws READINESS_FAILED on every vendor target (regression bar)', () => {
    for (const t of TARGETS) {
      it(`${t.target} → unsupported kind keeps surfacing READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET`, () => {
        const p = vfdProject();
        (p.machines[0].stations[0].equipment[0].type as string) =
          'pneumatic_cylinder_1pos';
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
  // 8. Determinism — twice-run byte-equality
  // =============================================================================

  it('8. all three backends are deterministic across two runs of the motor_vfd_simple fixture', () => {
    for (const t of TARGETS) {
      const a = t.generate(vfdProject(), CLOCK);
      const b = t.generate(vfdProject(), CLOCK);
      expect(a.map((art) => art.path)).toEqual(b.map((art) => art.path));
      expect(a.map((art) => art.content)).toEqual(
        b.map((art) => art.content),
      );
    }
  });

  it('9. manifest diagnostic codes are stable across two runs', () => {
    for (const t of TARGETS) {
      const codesA = (
        JSON.parse(
          t.generate(vfdProject(), CLOCK).find((x) => x.path === t.manifestPath)!
            .content,
        ).compiler_diagnostics ??
        JSON.parse(
          t.generate(vfdProject(), CLOCK).find((x) => x.path === t.manifestPath)!
            .content,
        ).compilerDiagnostics ??
        []
      ).map((d: { code: string }) => d.code);
      const codesB = (
        JSON.parse(
          t.generate(vfdProject(), CLOCK).find((x) => x.path === t.manifestPath)!
            .content,
        ).compiler_diagnostics ??
        JSON.parse(
          t.generate(vfdProject(), CLOCK).find((x) => x.path === t.manifestPath)!
            .content,
        ).compilerDiagnostics ??
        []
      ).map((d: { code: string }) => d.code);
      expect(codesA).toEqual(codesB);
    }
  });

  // =============================================================================
  // 10. No duplicate paths
  // =============================================================================

  it('10. each backend returns unique artifact paths', () => {
    for (const t of TARGETS) {
      const artifacts = t.generate(vfdProject(), CLOCK);
      const paths = artifacts.map((a) => a.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });
});

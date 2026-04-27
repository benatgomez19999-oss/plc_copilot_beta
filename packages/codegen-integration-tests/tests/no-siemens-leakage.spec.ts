import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateCodesysProject } from '@plccopilot/codegen-codesys';
import { generateRockwellProject } from '@plccopilot/codegen-rockwell';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

const CLOCK = { manifest: { generatedAt: '2026-04-25T00:00:00Z' } };

// =============================================================================
// Cross-backend OUTPUT leakage. Source-level leakage is enforced inside
// codegen-core's own `no-backend-leakage.spec.ts`. This integration test
// focuses on the rendered artifacts: each backend's `.st` output must NOT
// contain conventions owned by another backend.
//
// We strip IEC time/date literals (`T#5000MS`) and `(* *)` comments before
// scanning — those are legitimate IEC content.
// =============================================================================

function stripCommentsAndIecLiterals(content: string): string {
  return content
    .replace(/\(\*[\s\S]*?\*\)/g, '')      // IEC block comments
    .replace(/\bT#[\w_]+/g, '')              // T#5000MS time literals
    .replace(/\bD#[\w_]+/g, '')              // D# date literals
    .replace(/\bL#[\w_]+/g, '');             // L# long literals
}

describe('no-siemens-leakage — Codesys generated output (.st)', () => {
  const codesysArtifacts = generateCodesysProject(clone(), CLOCK).filter(
    (a) => a.path.endsWith('.st'),
  );

  it('actually generates .st artifacts (sanity)', () => {
    expect(codesysArtifacts.length).toBeGreaterThan(0);
  });

  for (const artifact of codesysArtifacts) {
    describe(artifact.path, () => {
      const stripped = stripCommentsAndIecLiterals(artifact.content);

      it('contains no Siemens FB-local prefix (#identifier)', () => {
        const m = stripped.match(/#[A-Za-z_][A-Za-z0-9_]*/);
        expect(
          m,
          m
            ? `${artifact.path} leaks "${m[0]}" outside comments / time literals`
            : '',
        ).toBeNull();
      });

      it('contains no double-quoted PLC tag literals', () => {
        const m = stripped.match(/"[A-Za-z_][A-Za-z0-9_]*"/);
        expect(
          m,
          m ? `${artifact.path} leaks ${m[0]} — Siemens-style PLC tag` : '',
        ).toBeNull();
      });

      it('does not embed the literal string "DB_Alarms"', () => {
        expect(stripped).not.toContain('"DB_Alarms"');
      });

      it('does not embed an "io_ literal', () => {
        expect(stripped).not.toContain('"io_');
      });
    });
  }

  it('alarm manager uses GVL_Alarms.<bit> writes (not "DB_Alarms")', () => {
    const fbAlarms = codesysArtifacts.find((a) =>
      a.path.endsWith('FB_Alarms.st'),
    )!;
    expect(fbAlarms.content).toContain('GVL_Alarms.set_');
    expect(fbAlarms.content).toContain('GVL_Alarms.active_');
    expect(fbAlarms.content).not.toContain('"DB_Alarms"');
  });

  it('R_TRIG instances are declared and ticked without #', () => {
    const fbLoad = codesysArtifacts.find((a) =>
      a.path.endsWith('FB_StLoad.st'),
    )!;
    expect(fbLoad.content).toMatch(/\bR_TRIG_[a-z_0-9]+ : R_TRIG/);
    expect(fbLoad.content).toMatch(/\bR_TRIG_[a-z_0-9]+\(CLK := /);
    expect(fbLoad.content).not.toMatch(/#R_TRIG_/);
  });

  it('TON instances are declared and accessed without #', () => {
    const fbLoad = codesysArtifacts.find((a) =>
      a.path.endsWith('FB_StLoad.st'),
    )!;
    expect(fbLoad.content).toMatch(/\bTON_[a-z_0-9]+ : TON/);
    expect(fbLoad.content).toMatch(/\bTON_[a-z_0-9]+\.Q/);
    expect(fbLoad.content).not.toMatch(/#TON_/);
  });

  it('station FB writes set_ via GVL_Alarms on timeout', () => {
    const fbLoad = codesysArtifacts.find((a) =>
      a.path.endsWith('FB_StLoad.st'),
    )!;
    expect(fbLoad.content).toMatch(
      /GVL_Alarms\.set_al_cyl_ext_timeout := TRUE/,
    );
  });
});

// =============================================================================
// PART 3 — OUTPUT leakage. Rockwell `.st` artifacts must carry NEITHER Siemens
// nor Codesys conventions. The Rockwell namespace alias is `Alarms.<bit>`,
// not `GVL_Alarms.<bit>` and not `"DB_Alarms".<bit>`.
//
// Stripping rules: same as Codesys (block comments + IEC time literals)
// PLUS we keep `(* … *)` removal because the Rockwell renderer uses block
// comments for the routine banner and pseudo-IEC marker.
// =============================================================================

describe('no-siemens-leakage — Rockwell generated output (.st)', () => {
  const rockwellArtifacts = generateRockwellProject(clone(), CLOCK).filter(
    (a) => a.path.endsWith('.st'),
  );

  it('actually generates .st artifacts (sanity)', () => {
    expect(rockwellArtifacts.length).toBeGreaterThan(0);
  });

  for (const artifact of rockwellArtifacts) {
    describe(artifact.path, () => {
      const stripped = stripCommentsAndIecLiterals(artifact.content)
        // Strip line comments too (`// foo`); Rockwell renderer uses them.
        .replace(/\/\/[^\n]*/g, '');

      it('contains no Siemens FB-local prefix (#identifier)', () => {
        const m = stripped.match(/#[A-Za-z_][A-Za-z0-9_]*/);
        expect(
          m,
          m
            ? `${artifact.path} leaks "${m[0]}" outside comments / time literals`
            : '',
        ).toBeNull();
      });

      it('contains no double-quoted PLC tag literals', () => {
        const m = stripped.match(/"[A-Za-z_][A-Za-z0-9_]*"/);
        expect(
          m,
          m ? `${artifact.path} leaks ${m[0]} — Siemens-style PLC tag` : '',
        ).toBeNull();
      });

      it('does not embed the Siemens "DB_Alarms" literal', () => {
        expect(stripped).not.toContain('"DB_Alarms"');
      });

      it('does not embed the Codesys GVL_Alarms namespace', () => {
        expect(stripped).not.toContain('GVL_Alarms');
        expect(stripped).not.toContain('GVL_Parameters');
        expect(stripped).not.toContain('GVL_Recipes');
      });

      it('does not embed an "io_ literal', () => {
        expect(stripped).not.toContain('"io_');
      });
    });
  }

  it('alarm manager uses Alarms.<bit> writes (no GVL / no DB)', () => {
    const fbAlarms = rockwellArtifacts.find((a) =>
      a.path.endsWith('FB_Alarms.st'),
    )!;
    expect(fbAlarms.content).toContain('Alarms.set_');
    expect(fbAlarms.content).toContain('Alarms.active_');
    expect(fbAlarms.content).not.toContain('"DB_Alarms"');
    expect(fbAlarms.content).not.toContain('GVL_Alarms');
  });

  it('rising-edge ticks render as one-shot pattern (no R_TRIG FB instance call)', () => {
    const fbLoad = rockwellArtifacts.find((a) =>
      a.path.endsWith('FB_StLoad.st'),
    )!;
    expect(fbLoad.content).toMatch(
      /R_TRIG_[a-z_0-9]+ := [a-z_0-9.]+ AND NOT R_TRIG_[a-z_0-9]+_MEM;/,
    );
    // No FB-style R_TRIG_x(CLK := …) calls left over.
    expect(fbLoad.content).not.toMatch(/R_TRIG_[a-z_0-9]+\(CLK :=/);
  });

  it('R_TRIG / F_TRIG declarations are BOOL with _MEM companions (no IEC FB type)', () => {
    const fbLoad = rockwellArtifacts.find((a) =>
      a.path.endsWith('FB_StLoad.st'),
    )!;
    expect(fbLoad.content).toMatch(/R_TRIG_[a-z_0-9]+ : BOOL;/);
    expect(fbLoad.content).toMatch(/R_TRIG_[a-z_0-9]+_MEM : BOOL;/);
    expect(fbLoad.content).not.toMatch(/R_TRIG_[a-z_0-9]+ : R_TRIG/);
  });

  it('TAG_Alarms.st uses Alarms.<bit> namespace and Logix BOOL type', () => {
    const tag = rockwellArtifacts.find((a) =>
      a.path.endsWith('TAG_Alarms.st'),
    )!;
    expect(tag.content).toContain('Alarms.set_al_cyl_ext_timeout : BOOL;');
    expect(tag.content).not.toContain('"DB_Alarms"');
    expect(tag.content).not.toContain('GVL_Alarms');
  });

  it('TAG_Parameters.st uses Logix INT/DINT/REAL spelling (no IEC `Real`)', () => {
    const tag = rockwellArtifacts.find((a) =>
      a.path.endsWith('TAG_Parameters.st'),
    )!;
    expect(tag.content).toMatch(/p_weld_current : REAL := 150\.0;/);
    expect(tag.content).not.toMatch(/: Real(?![A-Za-z])/);
    expect(tag.content).not.toMatch(/: DInt(?![A-Za-z])/);
  });
});

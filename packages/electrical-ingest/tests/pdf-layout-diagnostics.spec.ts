// Sprint 84.1B — pure tests for the layout diagnostic rollup
// helpers in `src/sources/pdf-layout-diagnostics.ts`.

import { describe, expect, it } from 'vitest';

import {
  buildLayoutDiagnosticRollups,
  type LayoutPageFinding,
} from '../src/sources/pdf-layout-diagnostics.js';

function f(page: number, count: number): LayoutPageFinding {
  return { page, count };
}

describe('buildLayoutDiagnosticRollups (Sprint 84.1B)', () => {
  it('1. empty input produces zero diagnostics', () => {
    expect(
      buildLayoutDiagnosticRollups({
        multiColumnPages: [],
        regionClusterPages: [],
      }),
    ).toEqual([]);
  });

  it('2. single multi-column page uses singular "page N"', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(7, 2)],
      regionClusterPages: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('PDF_LAYOUT_MULTI_COLUMN_DETECTED');
    expect(out[0].severity).toBe('info');
    expect(out[0].message).toContain('page 7');
    expect(out[0].message).not.toContain('pages 7');
  });

  it('3. consecutive multi-column pages emit "pages X–Y" with same-count tail', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(7, 2), f(8, 2), f(9, 2), f(10, 2), f(11, 2), f(12, 2)],
      regionClusterPages: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain('pages 7–12');
    expect(out[0].message).toContain('(2 columns)');
  });

  it('4. non-consecutive multi-column pages compress correctly', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(1, 2), f(5, 2), f(7, 2), f(8, 2), f(9, 2)],
      regionClusterPages: [],
    });
    expect(out[0].message).toContain('pages 1, 5, 7–9');
  });

  it('5. multi-column count variation surfaces "ranged from min to max"', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(1, 2), f(5, 7), f(80, 3), f(86, 4)],
      regionClusterPages: [],
    });
    expect(out[0].message).toContain('Column counts ranged from 2 to 7');
  });

  it('6. single region-cluster page uses singular phrasing', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [],
      regionClusterPages: [f(24, 11)],
    });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('PDF_LAYOUT_REGION_CLUSTERED');
    expect(out[0].message).toContain('page 24');
    expect(out[0].message).toContain('Region count: 11');
  });

  it('7. many region-cluster pages compress + show min/max', () => {
    const findings: LayoutPageFinding[] = [];
    for (let p = 1; p <= 86; p++) findings.push(f(p, p === 1 ? 3 : 14));
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [],
      regionClusterPages: findings,
    });
    expect(out[0].message).toContain('pages 1–86');
    expect(out[0].message).toContain('Region counts ranged from 3 to 14');
  });

  it('8. drops non-finite / non-positive / non-numeric findings defensively', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [
        f(1, 2),
        f(NaN as number, 2),
        f(-3 as number, 2),
        f(2, NaN as number),
      ],
      regionClusterPages: [],
    });
    expect(out[0].message).toContain('page 1');
    // The non-finite page / count entries silently drop; only page 1 survives.
    expect(out[0].message).not.toContain('page 2');
  });

  it('9. dedupes repeated findings for the same page (idempotent re-runs)', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(7, 2), f(7, 2), f(7, 3)],
      regionClusterPages: [],
    });
    expect(out[0].message).toContain('page 7');
    expect(out[0].message).toContain('(2 columns)');
  });

  it('10. multi-column rollup is emitted before region-cluster rollup', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(1, 2)],
      regionClusterPages: [f(1, 4)],
    });
    expect(out.map((d) => d.code)).toEqual([
      'PDF_LAYOUT_MULTI_COLUMN_DETECTED',
      'PDF_LAYOUT_REGION_CLUSTERED',
    ]);
  });

  it('11. layout rollups carry no sourceRef (rollups span many pages)', () => {
    const out = buildLayoutDiagnosticRollups({
      multiColumnPages: [f(1, 2), f(5, 3)],
      regionClusterPages: [f(1, 4), f(5, 6)],
    });
    for (const d of out) {
      expect(d.sourceRef).toBeUndefined();
    }
  });
});

// Sprint 98 — pure tests for the parameter review-card helper.
// The helper is renderer-agnostic: it accepts a
// `PirParameterCandidate` from electrical-ingest and emits the
// strings + status badges the new review section will paint.
//
// What we pin:
//   - dtype labels (real / int / dint / bool / unknown).
//   - default / unit / range formatters across happy-path and
//     missing-field cases (including the en-dash range string).
//   - badge token mapping for present / missing / invalid /
//     out-of-range metadata.
//   - summary one-liner across happy + degraded inputs.
//   - helper does not mutate input; two calls deep-equal.
//   - tolerates undefined / NaN / Infinity / non-numeric junk
//     without throwing.

import { describe, expect, it } from 'vitest';
import type { PirParameterCandidate } from '@plccopilot/electrical-ingest';

import { buildParameterReviewView } from '../src/utils/parameter-review-view.js';

function fixture(
  overrides: Partial<PirParameterCandidate> = {},
): PirParameterCandidate {
  return {
    id: 'p_m01_speed',
    label: 'M01 speed setpoint',
    dataType: 'real',
    defaultValue: 50,
    unit: 'Hz',
    sourceRefs: [],
    confidence: { value: 0.9, reason: 'test' } as never,
    ...overrides,
  } as PirParameterCandidate;
}

// =============================================================================
// 1. dtype labels
// =============================================================================

describe('formatDataTypeLabel', () => {
  it('1. real / int / dint / bool capitalise correctly', () => {
    expect(buildParameterReviewView(fixture()).dataTypeLabel).toBe('Real');
    expect(
      buildParameterReviewView(fixture({ dataType: 'int' })).dataTypeLabel,
    ).toBe('Int');
    expect(
      buildParameterReviewView(fixture({ dataType: 'dint' })).dataTypeLabel,
    ).toBe('DInt');
    // bool isn't a numeric Parameter dtype the candidate carries
    // today, but the helper still labels it cleanly.
    expect(
      buildParameterReviewView(
        fixture({ dataType: 'bool' as never }),
      ).dataTypeLabel,
    ).toBe('Bool');
  });

  it('2. unknown / missing dtype falls back to "Unknown type"', () => {
    expect(
      buildParameterReviewView(fixture({ dataType: '' as never }))
        .dataTypeLabel,
    ).toBe('Unknown type');
    expect(
      buildParameterReviewView(fixture({ dataType: undefined as never }))
        .dataTypeLabel,
    ).toBe('Unknown type');
  });
});

// =============================================================================
// 2. default formatter
// =============================================================================

describe('formatDefaultLabel', () => {
  it('3. integer + float defaults stringify cleanly', () => {
    expect(
      buildParameterReviewView(fixture({ defaultValue: 50 })).defaultLabel,
    ).toBe('50');
    expect(
      buildParameterReviewView(fixture({ defaultValue: 50.5 })).defaultLabel,
    ).toBe('50.5');
  });

  it('4. missing / non-finite default falls back to "Missing default"', () => {
    expect(
      buildParameterReviewView(
        fixture({ defaultValue: undefined as never }),
      ).defaultLabel,
    ).toBe('Missing default');
    expect(
      buildParameterReviewView(fixture({ defaultValue: NaN })).defaultLabel,
    ).toBe('Missing default');
    expect(
      buildParameterReviewView(
        fixture({ defaultValue: Number.POSITIVE_INFINITY }),
      ).defaultLabel,
    ).toBe('Missing default');
  });
});

// =============================================================================
// 3. unit formatter
// =============================================================================

describe('formatUnitLabel', () => {
  it('5. explicit unit passes through verbatim', () => {
    expect(buildParameterReviewView(fixture()).unitLabel).toBe('Hz');
  });

  it('6. missing / empty / whitespace-only unit becomes "No unit"', () => {
    expect(
      buildParameterReviewView(fixture({ unit: undefined })).unitLabel,
    ).toBe('No unit');
    expect(buildParameterReviewView(fixture({ unit: '' })).unitLabel).toBe(
      'No unit',
    );
    expect(buildParameterReviewView(fixture({ unit: '   ' })).unitLabel).toBe(
      'No unit',
    );
  });
});

// =============================================================================
// 4. range formatter
// =============================================================================

describe('formatRangeLabel', () => {
  it('7. min + max prints "min–max" with an en-dash', () => {
    expect(
      buildParameterReviewView(fixture({ min: 0, max: 60 } as never)).rangeLabel,
    ).toBe('0–60');
  });

  it('8. min only prints "≥ min"', () => {
    expect(
      buildParameterReviewView(fixture({ min: 0 } as never)).rangeLabel,
    ).toBe('≥ 0');
  });

  it('9. max only prints "≤ max"', () => {
    expect(
      buildParameterReviewView(fixture({ max: 60 } as never)).rangeLabel,
    ).toBe('≤ 60');
  });

  it('10. min === max collapses to a single value', () => {
    expect(
      buildParameterReviewView(fixture({ min: 50, max: 50 } as never))
        .rangeLabel,
    ).toBe('50');
  });

  it('11. no range → "No range"', () => {
    expect(buildParameterReviewView(fixture()).rangeLabel).toBe('No range');
  });

  it('12. non-finite min / max → "Invalid range metadata"', () => {
    expect(
      buildParameterReviewView(
        fixture({ min: Number.POSITIVE_INFINITY } as never),
      ).rangeLabel,
    ).toBe('Invalid range metadata');
    expect(
      buildParameterReviewView(fixture({ max: NaN } as never)).rangeLabel,
    ).toBe('Invalid range metadata');
  });

  it('13. min > max → "Invalid range metadata"', () => {
    expect(
      buildParameterReviewView(fixture({ min: 100, max: 0 } as never))
        .rangeLabel,
    ).toBe('Invalid range metadata');
  });
});

// =============================================================================
// 5. badges
// =============================================================================

describe('parameter review badges', () => {
  function badgeLabels(view: ReturnType<typeof buildParameterReviewView>) {
    return view.badges.map((b) => `${b.token}|${b.label}`);
  }

  it('14. happy-path candidate emits Range + Unit badges', () => {
    const view = buildParameterReviewView(
      fixture({ min: 0, max: 60 } as never),
    );
    expect(badgeLabels(view)).toEqual([
      'ready|Range',
      'info|Unit Hz',
    ]);
  });

  it('15. missing range → info "No range" badge', () => {
    const view = buildParameterReviewView(fixture());
    expect(badgeLabels(view).some((b) => b === 'info|No range')).toBe(true);
  });

  it('16. missing unit → warning "No unit" badge', () => {
    const view = buildParameterReviewView(
      fixture({ unit: undefined, min: 0, max: 60 } as never),
    );
    expect(badgeLabels(view)).toEqual([
      'ready|Range',
      'warning|No unit',
    ]);
  });

  it('17. invalid range metadata → failed "Invalid range metadata" badge', () => {
    const view = buildParameterReviewView(
      fixture({ min: 100, max: 0 } as never),
    );
    expect(
      view.badges.some(
        (b) => b.token === 'failed' && b.label === 'Invalid range metadata',
      ),
    ).toBe(true);
  });

  it('18. default outside range → warning "Default outside range" badge', () => {
    const view = buildParameterReviewView(
      fixture({ defaultValue: 200, min: 0, max: 60 } as never),
    );
    expect(
      view.badges.some(
        (b) => b.token === 'warning' && b.label === 'Default outside range',
      ),
    ).toBe(true);
  });

  it('19. missing default → failed "Missing default" badge', () => {
    const view = buildParameterReviewView(
      fixture({ defaultValue: undefined as never }),
    );
    expect(
      view.badges.some(
        (b) => b.token === 'failed' && b.label === 'Missing default',
      ),
    ).toBe(true);
  });

  it('20. non-finite default → failed "Invalid default" badge', () => {
    const view = buildParameterReviewView(
      fixture({ defaultValue: Number.POSITIVE_INFINITY }),
    );
    expect(
      view.badges.some(
        (b) => b.token === 'failed' && b.label === 'Invalid default',
      ),
    ).toBe(true);
  });
});

// =============================================================================
// 6. summary line
// =============================================================================

describe('parameter review summary', () => {
  it('21. full happy path: type · default unit · range', () => {
    const view = buildParameterReviewView(
      fixture({ min: 0, max: 60 } as never),
    );
    expect(view.summary).toBe('Real · default 50 · Hz · range 0–60');
  });

  it('22. missing unit + range degrades cleanly', () => {
    const view = buildParameterReviewView(
      fixture({ unit: undefined as never }),
    );
    expect(view.summary).toBe('Real · default 50 · no unit · no range');
  });

  it('23. invalid range surfaces in the summary', () => {
    const view = buildParameterReviewView(
      fixture({ min: 100, max: 0 } as never),
    );
    expect(view.summary).toContain('invalid range');
  });

  it('24. missing default surfaces in the summary', () => {
    const view = buildParameterReviewView(
      fixture({ defaultValue: undefined as never }),
    );
    expect(view.summary).toContain('missing default');
  });
});

// =============================================================================
// 7. detail rows + immutability + determinism
// =============================================================================

describe('parameter review detail rows + invariants', () => {
  it('25. detail rows preserve a stable order: id, type, default, unit, min, max', () => {
    const view = buildParameterReviewView(
      fixture({ min: 0, max: 60 } as never),
    );
    expect(view.detailRows.map((r) => r.label)).toEqual([
      'Id',
      'Data type',
      'Default',
      'Unit',
      'Min',
      'Max',
    ]);
  });

  it('26. helper does not mutate the input candidate', () => {
    const p = fixture({ min: 0, max: 60 } as never);
    const before = JSON.stringify(p);
    buildParameterReviewView(p);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('27. two calls on the same input deep-equal', () => {
    const p = fixture({ min: 0, max: 60 } as never);
    const a = buildParameterReviewView(p);
    const b = buildParameterReviewView(p);
    expect(a).toEqual(b);
  });

  it('28. extra unknown candidate fields do not bleed into the view', () => {
    const polluted = {
      ...fixture({ min: 0, max: 60 } as never),
      content: 'should-not-appear',
      rawCsv: 'row_kind,name\n',
    } as unknown as PirParameterCandidate;
    const view = buildParameterReviewView(polluted);
    const json = JSON.stringify(view);
    expect(json).not.toContain('should-not-appear');
    expect(json).not.toContain('row_kind,');
  });

  it('29. label falls back to id when missing', () => {
    expect(
      buildParameterReviewView(fixture({ label: undefined })).label,
    ).toBe('p_m01_speed');
    expect(
      buildParameterReviewView(fixture({ label: '   ' })).label,
    ).toBe('p_m01_speed');
  });
});

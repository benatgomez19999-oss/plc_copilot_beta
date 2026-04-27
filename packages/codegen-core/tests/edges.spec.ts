import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  EdgeRegistry,
  edgeInstanceName,
} from '@plccopilot/codegen-core';
import { lowerExpression } from '@plccopilot/codegen-core';
import { buildSymbolTable } from '@plccopilot/codegen-core';
import { hasErrors } from '@plccopilot/codegen-core';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

function tableForStLoad() {
  const p = clone();
  const machine = p.machines[0]!;
  const station = machine.stations.find((s) => s.id === 'st_load')!;
  return buildSymbolTable(machine, station).table;
}

describe('edgeInstanceName — station-namespaced naming', () => {
  it('prefixes the stationId for rising()', () => {
    expect(edgeInstanceName('rising', 'io_part_sensor', 'st_load')).toEqual({
      instanceName: 'R_TRIG_st_load_io_part_sensor',
      triggerType: 'R_TRIG',
    });
  });

  it('prefixes the stationId for falling()', () => {
    expect(edgeInstanceName('falling', 'io_estop', 'st_load')).toEqual({
      instanceName: 'F_TRIG_st_load_io_estop',
      triggerType: 'F_TRIG',
    });
  });

  it('sanitises dotted refs to underscores', () => {
    expect(
      edgeInstanceName('rising', 'cyl01.sensor_extended', 'st_load').instanceName,
    ).toBe('R_TRIG_st_load_cyl01_sensor_extended');
  });

  it('omits the station prefix when stationId is empty', () => {
    expect(edgeInstanceName('rising', 'x').instanceName).toBe('R_TRIG_x');
  });

  it('keeps rising/edge → R_TRIG mapping', () => {
    expect(edgeInstanceName('edge', 'x', 'st_y').triggerType).toBe('R_TRIG');
  });
});

describe('EdgeRegistry — dedup + collision detection', () => {
  it('dedupes repeated registrations with the same source', () => {
    const table = tableForStLoad();
    const edges = new EdgeRegistry('st_load');
    lowerExpression(
      'rising(io_part_sensor) && rising(io_part_sensor)',
      table,
      edges,
    );
    expect(edges.size()).toBe(1);
    expect(edges.collectedDiagnostics()).toHaveLength(0);
  });

  it('emits EDGE_INSTANCE_COLLISION when two sources sanitise to the same name', () => {
    const edges = new EdgeRegistry('st_load');
    edges.register({
      instanceName: 'R_TRIG_st_load_cyl01_s1',
      triggerType: 'R_TRIG',
      sourceArgText: 'cyl01.s1',
      sourceSclExpr: { kind: 'Raw', text: '"io_a"' },
    });
    edges.register({
      instanceName: 'R_TRIG_st_load_cyl01_s1',
      triggerType: 'R_TRIG',
      sourceArgText: 'cyl01_s1',
      sourceSclExpr: { kind: 'Raw', text: '"io_b"' },
    });
    const d = edges.collectedDiagnostics();
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe('EDGE_INSTANCE_COLLISION');
    expect(d[0]!.severity).toBe('error');
    expect(d[0]!.stationId).toBe('st_load');
  });

  it('emits alphabetical output independent of insertion order', () => {
    const table = tableForStLoad();
    const a = new EdgeRegistry('st_load');
    const b = new EdgeRegistry('st_load');
    lowerExpression('rising(io_mot01_fb)', table, a);
    lowerExpression('rising(io_part_sensor)', table, a);
    lowerExpression('rising(io_part_sensor)', table, b);
    lowerExpression('rising(io_mot01_fb)', table, b);
    expect(a.all().map((e) => e.instanceName)).toEqual(
      b.all().map((e) => e.instanceName),
    );
  });
});

describe('lowerExpression — integration with station-scoped EdgeRegistry', () => {
  it('produces station-prefixed instances via lowerExpression', () => {
    const table = tableForStLoad();
    const edges = new EdgeRegistry('st_load');
    const res = lowerExpression('rising(io_part_sensor)', table, edges);
    expect(hasErrors(res.diagnostics)).toBe(false);
    expect(edges.all()[0]!.instanceName).toBe(
      'R_TRIG_st_load_io_part_sensor',
    );
  });

  it('auto-resolves bare equipment id via signal_in', () => {
    const table = tableForStLoad();
    const edges = new EdgeRegistry('st_load');
    const res = lowerExpression('rising(sen_part)', table, edges);
    expect(hasErrors(res.diagnostics)).toBe(false);
    const [inst] = edges.all();
    expect(inst.instanceName).toBe('R_TRIG_st_load_sen_part');
    // Sprint 38 — assert against the **neutral** storage shape rather
    // than a pre-rendered Siemens `sclName`. The bare equipment id
    // `sen_part` resolves via the equipment's `signal_in` role to
    // the global IO `io_part_sensor`. After the symbol layer was
    // made vendor-neutral, the resolver returns the equipment role
    // (`pirName: "sen_part.signal_in"`, `kind: "equipment_role"`)
    // and the storage points at the IO target. The Siemens
    // `"io_part_sensor"` text is rendered by `renderRef` /
    // `renderStorage` at backend time, not core.
    expect(inst.sourceSclExpr).toMatchObject({
      kind: 'SymbolRef',
      symbol: expect.objectContaining({
        pirName: 'sen_part.signal_in',
        kind: 'equipment_role',
        storage: { kind: 'global', name: 'io_part_sensor' },
      }),
    });
  });

  it('unresolved edge source degrades to warning + symbolic CLK', () => {
    const table = tableForStLoad();
    const edges = new EdgeRegistry('st_load');
    const res = lowerExpression('rising(ghost_signal)', table, edges);
    const d = res.diagnostics.find((x) => x.code === 'UNKNOWN_REF');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('warning');
    expect(edges.size()).toBe(1);
  });

  it('edge() emits info diagnostic and lowers as R_TRIG', () => {
    const table = tableForStLoad();
    const edges = new EdgeRegistry('st_load');
    const res = lowerExpression('edge(io_part_sensor)', table, edges);
    expect(
      res.diagnostics.some(
        (d) => d.severity === 'info' && d.code === 'EDGE_LOWERED_AS_RISING',
      ),
    ).toBe(true);
    expect(edges.all()[0]!.triggerType).toBe('R_TRIG');
  });
});

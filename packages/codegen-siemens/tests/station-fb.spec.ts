import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project, Station } from '@plccopilot/pir';
import { generateStationFb } from '../src/generators/station-fb.js';
import { CodegenError } from '../src/types.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

function stationById(project: Project, id: string): Station {
  const s = project.machines[0]!.stations.find((x) => x.id === id);
  if (!s) throw new Error(`fixture missing station ${id}`);
  return s;
}

describe('generateStationFb — structural invariants (st_load)', () => {
  const project = clone();
  const machine = project.machines[0]!;
  const station = stationById(project, 'st_load');
  const artifact = generateStationFb(machine, station);

  it('emits canonical FUNCTION_BLOCK header + footer', () => {
    expect(artifact.path).toBe('siemens/FB_StLoad.scl');
    expect(artifact.kind).toBe('scl');
    expect(artifact.content).toContain('FUNCTION_BLOCK "FB_StLoad"');
    expect(artifact.content).toContain('END_FUNCTION_BLOCK');
  });

  it('declares VAR_INPUT / VAR_OUTPUT / VAR sections in order', () => {
    const c = artifact.content;
    const vi = c.indexOf('VAR_INPUT');
    const vo = c.indexOf('VAR_OUTPUT');
    const vv = c.indexOf('\nVAR\n');
    expect(vi).toBeGreaterThan(-1);
    expect(vo).toBeGreaterThan(vi);
    expect(vv).toBeGreaterThan(vo);
    expect(c).toContain('i_mode : INT');
    expect(c).toContain('i_estop_active : BOOL');
    expect(c).toMatch(/state\s*:\s*INT\s*:=\s*0/);
  });

  it('emits CASE dispatch referencing #state with every declared state id', () => {
    expect(artifact.content).toContain('CASE #state OF');
    for (const id of [
      'st_idle',
      'st_extending',
      'st_holding',
      'st_retracting',
      'st_fault',
    ]) {
      expect(artifact.content).toContain(id);
    }
  });

  it('emits wildcard transitions before CASE (estop keyword lowered to #i_estop_active)', () => {
    const c = artifact.content;
    const wp = c.indexOf('Wildcard');
    const cp = c.indexOf('CASE #state OF');
    expect(wp).toBeGreaterThan(-1);
    expect(cp).toBeGreaterThan(wp);
    expect(c).toContain('#i_estop_active');
  });

  it('lowers equipment.role triggers to the bound IO tag', () => {
    expect(artifact.content).toContain('"io_cyl01_ext"');
    expect(artifact.content).toContain('"io_cyl01_ret"');
  });

  it('lowers edge / timer function calls to SCL handles', () => {
    expect(artifact.content).toContain('#R_TRIG_st_load_sen_part.Q');
    expect(artifact.content).toContain('#hold_timer.Q');
  });
});

describe('generateStationFb — edge-trigger instances (st_load)', () => {
  const project = clone();
  const station = stationById(project, 'st_load');
  const artifact = generateStationFb(project.machines[0]!, station);

  it('declares R_TRIG instance in VAR for each rising() usage', () => {
    // rising(sen_part) is the only edge in the fixture for st_load
    // Under station-namespaced naming it becomes R_TRIG_st_load_sen_part.
    expect(artifact.content).toContain('R_TRIG_st_load_sen_part : R_TRIG');
  });

  it('emits the tick block header comment before CASE', () => {
    const c = artifact.content;
    const tick = c.indexOf('--- Edge-trigger updates ---');
    const kase = c.indexOf('CASE #state OF');
    expect(tick).toBeGreaterThan(-1);
    expect(kase).toBeGreaterThan(tick);
  });

  it('calls the trigger with CLK := <resolved source>', () => {
    // sen_part is a sensor_discrete; the source auto-resolves to its
    // signal_in IO tag "io_part_sensor".
    expect(artifact.content).toMatch(
      /#R_TRIG_st_load_sen_part\(CLK\s*:=\s*"io_part_sensor"\);/,
    );
  });

  it('places the tick block BEFORE wildcard transitions and CASE', () => {
    const c = artifact.content;
    const tick = c.indexOf('--- Edge-trigger updates ---');
    const wildcard = c.indexOf('Wildcard');
    expect(tick).toBeGreaterThan(-1);
    expect(wildcard).toBeGreaterThan(tick);
  });
});

describe('generateStationFb — falling edges', () => {
  it('declares F_TRIG and emits the tick with falling()', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    // inject a falling-edge trigger on a known IO
    s.sequence.transitions[0]!.trigger = 'falling(io_part_sensor)';
    const c = generateStationFb(p.machines[0]!, s).content;
    expect(c).toContain('F_TRIG_st_load_io_part_sensor : F_TRIG');
    expect(c).toMatch(
      /#F_TRIG_st_load_io_part_sensor\(CLK\s*:=\s*"io_part_sensor"\);/,
    );
    expect(c).toContain('#F_TRIG_st_load_io_part_sensor.Q');
  });
});

describe('generateStationFb — artifact diagnostics', () => {
  it('attaches diagnostics with info severity from timeouts', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    const artifact = generateStationFb(p.machines[0]!, s);
    expect(artifact.diagnostics).toBeDefined();
    expect(
      artifact.diagnostics!.some(
        (d) => d.code === 'TIMEOUT_NO_AUTO_TRANSITION' && d.severity === 'info',
      ),
    ).toBe(true);
  });

  it('attaches info diagnostic when edge() is lowered as rising()', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.transitions[0]!.trigger = 'edge(io_part_sensor)';
    const artifact = generateStationFb(p.machines[0]!, s);
    expect(artifact.diagnostics).toBeDefined();
    expect(
      artifact.diagnostics!.some(
        (d) => d.code === 'EDGE_LOWERED_AS_RISING' && d.severity === 'info',
      ),
    ).toBe(true);
  });
});

describe('generateStationFb — timeouts (st_load)', () => {
  const project = clone();
  const station = stationById(project, 'st_load');
  const artifact = generateStationFb(project.machines[0]!, station);

  it('declares a TON instance per transition timeout', () => {
    expect(artifact.content).toContain('TON_t_extended : TON');
    expect(artifact.content).toContain('TON_t_retracted : TON');
  });

  it('comments each TON declaration with its alarm_id and duration', () => {
    expect(artifact.content).toMatch(
      /TON_t_extended\s*:\s*TON;.*alarm:\s*al_cyl_ext_timeout.*\(5000 ms\)/,
    );
    expect(artifact.content).toMatch(
      /TON_t_retracted\s*:\s*TON;.*alarm:\s*al_cyl_ret_timeout.*\(5000 ms\)/,
    );
  });

  it('ticks the TON while the source state is active and raises the alarm tag on expiry', () => {
    const c = artifact.content;
    expect(c).toMatch(
      /#TON_t_extended\(IN\s*:=\s*\(#state\s*=\s*1\)\s*,\s*PT\s*:=\s*T#5000MS\)/,
    );
    expect(c).toContain('IF #TON_t_extended.Q THEN');
    expect(c).toContain('"DB_Alarms".set_al_cyl_ext_timeout := TRUE');
    expect(c).toMatch(
      /#TON_t_retracted\(IN\s*:=\s*\(#state\s*=\s*3\)\s*,\s*PT\s*:=\s*T#5000MS\)/,
    );
    expect(c).toContain('"DB_Alarms".set_al_cyl_ret_timeout := TRUE');
  });
});

describe('generateStationFb — activities', () => {
  it('lowers pneumatic_cylinder_2pos extend into extend_cmd + solenoid wiring', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.states[1]!.activity = { activate: ['cyl01.extend'] };
    const c = generateStationFb(p.machines[0]!, s).content;
    expect(c).toContain('cyl01_extend_cmd : BOOL');
    expect(c).toContain('#cyl01_extend_cmd := FALSE;'); // cycle reset
    expect(c).toContain('#cyl01_extend_cmd := TRUE;');  // inside CASE branch
    expect(c).toContain('"io_cyl01_sol" := #cyl01_extend_cmd');
  });

  it('lowers pneumatic_cylinder_2pos retract into retract_cmd + inverted solenoid wiring', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.states[3]!.activity = { activate: ['cyl01.retract'] };
    const c = generateStationFb(p.machines[0]!, s).content;
    expect(c).toContain('cyl01_retract_cmd : BOOL');
    expect(c).toContain('#cyl01_retract_cmd := TRUE;');
    // because interlock already introduces cyl01_extend_cmd, both cmds coexist ->
    // wiring uses mutex pattern.
    expect(c).toMatch(
      /"io_cyl01_sol"\s*:=\s*#cyl01_extend_cmd\s+AND\s+NOT\s+#cyl01_retract_cmd/,
    );
  });

  it('lowers motor_simple run into run_cmd and drives run_out', () => {
    const p = clone();
    const s = stationById(p, 'st_weld');
    s.sequence.states[1]!.activity = { activate: ['mot01.run'] };
    const c = generateStationFb(p.machines[0]!, s).content;
    expect(c).toContain('mot01_run_cmd : BOOL');
    expect(c).toContain('#mot01_run_cmd := TRUE;');
    expect(c).toContain('"io_mot01_run" := #mot01_run_cmd');
  });

  it('accepts motor_simple run_fwd and ORs it into run_out', () => {
    const p = clone();
    const s = stationById(p, 'st_weld');
    s.sequence.states[1]!.activity = { activate: ['mot01.run', 'mot01.run_fwd'] };
    const c = generateStationFb(p.machines[0]!, s).content;
    expect(c).toContain('mot01_run_cmd : BOOL');
    expect(c).toContain('mot01_run_fwd_cmd : BOOL');
    expect(c).toMatch(
      /"io_mot01_run"\s*:=\s*#mot01_run_cmd\s+OR\s+#mot01_run_fwd_cmd/,
    );
  });

  it('tolerates sensor_discrete equipment with no activity', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    // no activity on sensor — should just generate fine
    expect(() => generateStationFb(p.machines[0]!, s)).not.toThrow();
  });

  it('rejects an activity not allowed by the equipment type', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.states[1]!.activity = { activate: ['cyl01.fly'] };
    expect(() => generateStationFb(p.machines[0]!, s)).toThrow(CodegenError);
    try {
      generateStationFb(p.machines[0]!, s);
    } catch (e) {
      expect((e as CodegenError).code).toBe('UNSUPPORTED_ACTIVITY');
      expect((e as CodegenError).message).toMatch(/fly/);
    }
  });

  it('rejects activation targeting a sensor_discrete', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.states[0]!.activity = { activate: ['sen_part.pulse'] };
    expect(() => generateStationFb(p.machines[0]!, s)).toThrow(
      /sensor_discrete/,
    );
  });
});

describe('generateStationFb — interlocks (st_load)', () => {
  const project = clone();
  const station = stationById(project, 'st_load');
  const artifact = generateStationFb(project.machines[0]!, station);

  it('declares the inhibited cmd var even if no state activates it', () => {
    expect(artifact.content).toContain('cyl01_extend_cmd : BOOL');
  });

  it('emits an interlock block that forces the inhibited cmd to FALSE', () => {
    const c = artifact.content;
    expect(c).toContain('il_cyl01_no_extend_on_fault');
    expect(c).toMatch(
      /IF\s*\(#i_estop_active\)\s*THEN[\s\S]*?#cyl01_extend_cmd\s*:=\s*FALSE/,
    );
  });

  it('places the interlock block AFTER the CASE and BEFORE the output wiring', () => {
    const c = artifact.content;
    const casePos = c.indexOf('END_CASE;');
    const interlockPos = c.indexOf('Interlocks (functional inhibition');
    const wiringPos = c.indexOf('Output wiring');
    expect(casePos).toBeGreaterThan(-1);
    expect(interlockPos).toBeGreaterThan(casePos);
    expect(wiringPos).toBeGreaterThan(interlockPos);
  });

  it('ignores interlocks whose target equipment lives in another station', () => {
    const p = clone();
    p.machines[0]!.interlocks[0]!.inhibits = 'mot01.run'; // mot01 is in st_weld
    const a = generateStationFb(p.machines[0]!, stationById(p, 'st_load'));
    expect(a.content).not.toContain('il_cyl01_no_extend_on_fault');
    expect(a.content).not.toContain('mot01_run_cmd');
  });

  it('throws INTERLOCK_ROLE_UNRESOLVED on unsupported inhibited role', () => {
    const p = clone();
    p.machines[0]!.interlocks[0]!.inhibits = 'cyl01.fly';
    expect(() => generateStationFb(p.machines[0]!, stationById(p, 'st_load'))).toThrow(
      CodegenError,
    );
    try {
      generateStationFb(p.machines[0]!, stationById(p, 'st_load'));
    } catch (e) {
      expect((e as CodegenError).code).toBe('INTERLOCK_ROLE_UNRESOLVED');
    }
  });
});

describe('generateStationFb — error surfaces', () => {
  it('throws CodegenError for a trigger referencing unknown equipment', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.transitions[0]!.trigger = 'ghost_eq.sensor_extended';
    expect(() => generateStationFb(p.machines[0]!, s)).toThrow(CodegenError);
  });

  it('throws for an unresolvable bare identifier in a guard', () => {
    const p = clone();
    const s = stationById(p, 'st_load');
    s.sequence.transitions[0]!.guard = 'totally_unknown';
    expect(() => generateStationFb(p.machines[0]!, s)).toThrow(/does not resolve/);
  });
});

describe('generateStationFb — alarm write contract (DB_Alarms v2)', () => {
  const project = clone();
  const station = stationById(project, 'st_load');
  const artifact = generateStationFb(project.machines[0]!, station);

  it('writes set_<id> on timeout, never active_<id>', () => {
    const c = artifact.content;
    expect(c).toContain('"DB_Alarms".set_al_cyl_ext_timeout := TRUE');
    expect(c).toContain('"DB_Alarms".set_al_cyl_ret_timeout := TRUE');
    expect(c).not.toMatch(
      /"DB_Alarms"\.active_al_[a-z_]+ := TRUE/,
    );
  });
});

describe('generateStationFb — st_weld smoke', () => {
  const project = clone();
  const station = stationById(project, 'st_weld');
  const artifact = generateStationFb(project.machines[0]!, station);

  it('emits a FUNCTION_BLOCK for the weld station with its state ids', () => {
    expect(artifact.path).toBe('siemens/FB_StWeld.scl');
    expect(artifact.content).toContain('FUNCTION_BLOCK "FB_StWeld"');
    expect(artifact.content).toContain('st_running');
    expect(artifact.content).toContain('#R_TRIG_st_weld_start_button.Q');
  });

  it('has no timer block when the station has no transition timeouts', () => {
    expect(artifact.content).not.toContain('Transition timeouts');
  });
});

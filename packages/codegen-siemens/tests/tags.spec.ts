import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import { generateTagsTable } from '../src/generators/tags.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

describe('generateTagsTable', () => {
  const artifact = generateTagsTable(clone());

  it('produces a CSV artifact at the canonical path', () => {
    expect(artifact.path).toBe('siemens/Tags_Main.csv');
    expect(artifact.kind).toBe('csv');
  });

  it('header matches the Siemens import convention', () => {
    const firstLine = artifact.content.split('\n')[0]!;
    expect(firstLine).toBe('Name;DataType;Address;Comment');
  });

  it('contains every physical IO signal with mapped address + dtype', () => {
    const c = artifact.content;
    expect(c).toContain('io_cyl01_sol;Bool;%Q0.0');
    expect(c).toContain('io_cyl01_ext;Bool;%I0.0');
    expect(c).toContain('io_cyl01_ret;Bool;%I0.1');
    expect(c).toContain('io_part_sensor;Bool;%I0.2');
    expect(c).toContain('io_mot01_run;Bool;%Q0.1');
    expect(c).toContain('io_mot01_fb;Bool;%I0.3');
    expect(c).toContain('io_estop;Bool;%I0.4');
  });

  it('leaves the Address column empty for DB-area IOs', () => {
    const c = artifact.content;
    expect(c).toMatch(/io_weld_time_sp;DInt;;/);
    expect(c).toMatch(/io_weld_current_sp;Real;;/);
  });

  it('contains every parameter with empty address column', () => {
    const c = artifact.content;
    expect(c).toMatch(/p_weld_time;DInt;;/);
    expect(c).toMatch(/p_weld_current;Real;;/);
  });

  it('does NOT include alarm rows — alarms moved to DB_Alarms (v0.2)', () => {
    const c = artifact.content;
    expect(c).not.toMatch(/al_cyl_ext_timeout;Bool;;/);
    expect(c).not.toMatch(/al_cyl_ret_timeout;Bool;;/);
    expect(c).not.toMatch(/al_estop_active;Bool;;/);
  });

  it('contains a per-station state Int output', () => {
    const c = artifact.content;
    expect(c).toMatch(/st_load_state;Int;;/);
    expect(c).toMatch(/st_weld_state;Int;;/);
  });

  it('deduplicates entries that share a Name', () => {
    const dataLines = artifact.content.trim().split('\n').slice(1);
    const names = dataLines.map((l) => l.split(';')[0]!);
    expect(names.length).toBe(new Set(names).size);
  });

  it('never emits raw CR/LF inside a row — exactly 4 columns per line', () => {
    const lines = artifact.content.split('\n').filter((l) => l.length > 0);
    for (const l of lines) {
      const cols = l.split(';');
      expect(cols.length).toBe(4);
    }
  });

  it('is deterministic across two calls', () => {
    const a = generateTagsTable(clone()).content;
    const b = generateTagsTable(clone()).content;
    expect(a).toBe(b);
  });
});

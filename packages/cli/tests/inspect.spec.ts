import { describe, expect, it } from 'vitest';
import { runInspect } from '../src/commands/inspect.js';
import { bufferedIO, fixturePath } from './test-helpers.js';

describe('inspect command', () => {
  it('prints project id, name, pir_version', async () => {
    const io = bufferedIO();
    const code = await runInspect({ input: fixturePath() }, io);
    expect(code).toBe(0);
    expect(io.out()).toContain('Project: prj_weldline');
    expect(io.out()).toContain('PIR version:');
  });

  it('prints machine count + per-machine counts', async () => {
    const io = bufferedIO();
    await runInspect({ input: fixturePath() }, io);
    expect(io.out()).toMatch(/Machines: \d+/);
    expect(io.out()).toContain('stations:');
    expect(io.out()).toContain('equipment:');
    expect(io.out()).toContain('io:');
    expect(io.out()).toContain('parameters:');
    expect(io.out()).toContain('recipes:');
    expect(io.out()).toContain('alarms:');
  });

  it('lists each station with state + transition counts', async () => {
    const io = bufferedIO();
    await runInspect({ input: fixturePath() }, io);
    // weldline fixture has st_load and st_weld
    expect(io.out()).toMatch(/st_load.*states.*transitions/);
    expect(io.out()).toMatch(/st_weld.*states.*transitions/);
  });

  it('mentions the supported targets line', async () => {
    const io = bufferedIO();
    await runInspect({ input: fixturePath() }, io);
    expect(io.out()).toContain('Supported targets:');
    expect(io.out()).toContain('siemens');
    expect(io.out()).toContain('codesys');
    expect(io.out()).toContain('rockwell');
  });

  it('returns exit code 1 when input file is missing', async () => {
    const io = bufferedIO();
    const code = await runInspect({ input: '/no/such.json' }, io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/cannot read PIR file/);
  });
});

describe('cli dispatcher (main)', () => {
  it('returns 0 + prints help when no command given', async () => {
    const { main } = await import('../src/cli.js');
    const io = bufferedIO();
    const code = await main([], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('plccopilot — PLC Copilot codegen CLI');
  });

  it('returns 1 + prints help hint on unknown command', async () => {
    const { main } = await import('../src/cli.js');
    const io = bufferedIO();
    const code = await main(['totally-unknown'], io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/unknown command/);
  });

  it('returns 1 when generate is missing required flags', async () => {
    const { main } = await import('../src/cli.js');
    const io = bufferedIO();
    const code = await main(['generate'], io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/missing required flag/);
  });

  it('returns 1 on invalid backend value', async () => {
    const { main } = await import('../src/cli.js');
    const io = bufferedIO();
    const code = await main(
      [
        'generate',
        '--input',
        fixturePath(),
        '--backend',
        'foo',
        '--out',
        '/tmp/whatever',
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toMatch(/invalid --backend/);
  });

  it('parses `--flag=value` correctly', async () => {
    const { parseArgs } = await import('../src/cli.js');
    const r = parseArgs(['generate', '--input=./pir.json', '--backend=siemens']);
    expect(r.command).toBe('generate');
    expect(r.flags.input).toBe('./pir.json');
    expect(r.flags.backend).toBe('siemens');
  });

  it('parses `--flag value` correctly', async () => {
    const { parseArgs } = await import('../src/cli.js');
    const r = parseArgs([
      'generate',
      '--input',
      './pir.json',
      '--backend',
      'siemens',
    ]);
    expect(r.flags.input).toBe('./pir.json');
    expect(r.flags.backend).toBe('siemens');
  });
});

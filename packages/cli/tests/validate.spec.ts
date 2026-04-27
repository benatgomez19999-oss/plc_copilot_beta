import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runValidate } from '../src/commands/validate.js';
import {
  bufferedIO,
  cleanupTmp,
  fixturePath,
  makeTmpDir,
} from './test-helpers.js';

describe('validate command', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    cleanupTmp(tmp);
  });

  it('returns exit code 0 for the canonical weldline fixture', async () => {
    const io = bufferedIO();
    const code = await runValidate({ input: fixturePath() }, io);
    expect(code).toBe(0);
    expect(io.out()).toMatch(/Validation: \d+ errors,/);
  });

  it('returns exit code 1 when the file does not exist', async () => {
    const io = bufferedIO();
    const code = await runValidate({ input: '/no/such.json' }, io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/cannot read PIR file/);
  });

  it('returns exit code 1 when JSON is malformed', async () => {
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{ broken', 'utf-8');
    const io = bufferedIO();
    const code = await runValidate({ input: bad }, io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/invalid JSON/);
  });

  it('returns exit code 1 when the JSON does not match ProjectSchema', async () => {
    const bad = join(tmp, 'bad-schema.json');
    writeFileSync(bad, JSON.stringify({ foo: 'bar' }), 'utf-8');
    const io = bufferedIO();
    const code = await runValidate({ input: bad }, io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/PIR schema validation failed/);
  });

  it('always prints a final "Validation: …" summary line on a parseable PIR', async () => {
    // Once we get past ProjectSchema, the command MUST emit the summary line
    // regardless of report content. Verifies the unconditional reporting
    // contract — exit code 2 (vs 0) is exercised by real PIR projects whose
    // domain rules fire; we don't synthesise such a project here to avoid
    // coupling the CLI test to a specific PIR rule's implementation detail.
    const io = bufferedIO();
    const code = await runValidate({ input: fixturePath() }, io);
    expect([0, 2]).toContain(code);
    expect(io.out()).toMatch(
      /Validation: \d+ errors, \d+ warnings, \d+ info/,
    );
  });
});

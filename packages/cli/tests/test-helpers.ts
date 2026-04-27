import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIO } from '../src/cli.js';

/**
 * Buffered CliIO for tests — captures every `log`/`error` call so assertions
 * can inspect output without polluting the suite's stdout.
 */
export interface BufferedIO extends CliIO {
  logs: string[];
  errors: string[];
  /** Joined stdout / stderr (newline-separated). */
  out(): string;
  err(): string;
}

export function bufferedIO(): BufferedIO {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    logs,
    errors,
    out: () => logs.join('\n'),
    err: () => errors.join('\n'),
  };
}

/**
 * Create a unique temporary directory and return its path. Caller must clean
 * it up via `cleanupTmp` (typically in `afterEach`).
 */
export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'plccli-'));
}

export function cleanupTmp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Absolute path to the canonical PIR fixture (`weldline.json`). Resolved
 * relative to this test-helpers file so the tests don't depend on `cwd`.
 */
export function fixturePath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '../../pir/src/fixtures/weldline.json');
}

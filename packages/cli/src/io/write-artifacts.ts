import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { fail } from '../errors.js';

/**
 * Write each artifact's `content` to `<outDir>/<artifact.path>`. Creates
 * intermediate directories as needed.
 *
 * Security guards (every artifact is checked):
 *   - artifact.path may NOT be absolute
 *   - artifact.path may NOT escape `outDir` via `..` segments
 *
 * Both rules raise `CliError` (exit 1) and abort the write. No partial
 * writes are rolled back — the caller decides whether to clean `outDir`
 * on failure.
 *
 * Returns the absolute paths of the files written, in input order.
 */
export function writeArtifacts(
  outDir: string,
  artifacts: readonly GeneratedArtifact[],
): string[] {
  const baseAbs = resolve(outDir);
  const written: string[] = [];

  for (const a of artifacts) {
    if (typeof a.path !== 'string' || a.path.length === 0) {
      fail(`artifact has empty path`, 1);
    }
    if (isAbsolute(a.path)) {
      fail(`refusing absolute artifact path: ${a.path}`, 1);
    }
    const normalized = normalize(a.path).replace(/^[\\/]+/, '');
    const target = resolve(baseAbs, normalized);
    const isInside =
      target === baseAbs ||
      target.startsWith(baseAbs + sep) ||
      target.startsWith(baseAbs + '/');
    if (!isInside) {
      fail(`artifact path escapes output dir: ${a.path}`, 1);
    }

    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, a.content, 'utf-8');
    } catch (e) {
      fail(`failed to write artifact "${a.path}"`, 1, e);
    }

    written.push(target);
  }

  return written;
}

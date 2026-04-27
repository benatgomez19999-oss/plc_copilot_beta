import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `codegen-core` must contain ZERO vendor-lexical strings. Any leakage means
 * a backend convention has bled into the shared compiler — a future backend
 * (B&R, Beckhoff, Schneider) would inherit the bias.
 *
 * Patterns are matched against source files AFTER stripping `// …` and
 * `/* … *​/` comments, so doc text that mentions a vendor is fine — only
 * runtime string literals trip the test.
 */

interface ForbiddenPattern {
  pattern: RegExp;
  label: string;
  reason: string;
}

const FORBIDDEN: ForbiddenPattern[] = [
  // ---- Filesystem extensions / directory prefixes ----
  {
    pattern: /['"`]\.scl['"`]|['"`][^'"`]*\.scl['"`]/,
    label: '`.scl` literal',
    reason: 'Siemens artifact extension — must be set by the Siemens backend renderer.',
  },
  {
    pattern: /['"`]\.st['"`]|['"`][^'"`]*\.st['"`]/,
    label: '`.st` literal',
    reason: 'Codesys/Rockwell artifact extension — set by their renderers.',
  },
  // Vendor directory PREFIXES (e.g. `'siemens/'`, `'codesys/'`). The bare
  // BackendId values (`'siemens'`, `'codesys'`, `'rockwell'`) are intentionally
  // allowed because they are part of the BackendId union literals in
  // `compiler/backend.ts`.
  {
    pattern: /['"`]siemens\/['"`]/,
    label: '`siemens/` directory prefix',
    reason: 'Siemens output directory — owned by codegen-siemens.',
  },
  {
    pattern: /['"`]codesys\/['"`]/,
    label: '`codesys/` directory prefix',
    reason: 'Codesys output directory — owned by codegen-codesys.',
  },
  {
    pattern: /['"`]rockwell\/['"`]/,
    label: '`rockwell/` directory prefix',
    reason: 'Rockwell output directory — owned by codegen-rockwell.',
  },
  // ---- Backend-specific lexical conventions in string literals ----
  {
    pattern: /['"`]GVL_Alarms['"`]|['"`]GVL_Parameters['"`]|['"`]GVL_Recipes['"`]/,
    label: 'GVL_<X> literal',
    reason:
      'Codesys-specific namespace — owned by @plccopilot/codegen-codesys.',
  },
  {
    pattern: /['"`]Alarms\.set_['"`]|['"`]Alarms\.active_['"`]/,
    label: 'Alarms.<bit> literal',
    reason:
      'Rockwell-specific namespace — owned by @plccopilot/codegen-rockwell.',
  },
  {
    pattern: /['"`]Alarms['"`]|['"`]Parameters['"`]|['"`]Recipes['"`]/,
    label: 'Rockwell namespace alias literal',
    reason:
      'Rockwell namespace prefixes (Alarms / Parameters / Recipes) are owned by codegen-rockwell.',
  },
  {
    pattern: /\bROUTINE\s|\bEND_ROUTINE\b/,
    label: 'ROUTINE keyword',
    reason: 'Rockwell-specific routine envelope — owned by the Rockwell renderer.',
  },
  {
    pattern: /\bFUNCTION_BLOCK\b\s*['"`]/,
    label: 'FUNCTION_BLOCK "<name>"',
    reason: 'Siemens-style FB header — owned by the Siemens SCL renderer.',
  },
  {
    pattern: /S7_Optimized_Access/,
    label: 'S7_Optimized_Access',
    reason: 'Siemens TIA attribute — owned by the Siemens SCL renderer.',
  },
  {
    pattern: /Studio\s*5000/i,
    label: 'Studio 5000 mention',
    reason: 'Rockwell trade name — keep in Rockwell-side docs, not in core source.',
  },
  // ---- Siemens-style PLC tags ----
  {
    pattern: /['"`]"DB_Alarms"\./,
    label: '"DB_Alarms".<bit> literal',
    reason: 'Siemens-quoted DB access — owned by the Siemens renderer.',
  },
];

const SCAN_ROOT = 'src';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const SCANNED: { file: string; clean: string }[] = (() => {
  const all: { file: string; clean: string }[] = [];
  for (const file of listTsFiles(SCAN_ROOT)) {
    const raw = readFileSync(file, 'utf-8');
    all.push({
      file: relative(process.cwd(), file),
      clean: stripComments(raw),
    });
  }
  return all;
})();

describe('no-backend-leakage — codegen-core must be vendor-neutral', () => {
  it('discovers TypeScript source files in core', () => {
    expect(SCANNED.length).toBeGreaterThan(0);
  });

  for (const { pattern, label, reason } of FORBIDDEN) {
    describe(`forbids ${label}`, () => {
      for (const { file, clean } of SCANNED) {
        const m = clean.match(pattern);
        it(file, () => {
          expect(
            m,
            m ? `${file} contains "${m[0]}" — ${reason}` : '',
          ).toBeNull();
        });
      }
    });
  }
});

describe('no-backend-leakage — sanity (the scan actually runs)', () => {
  it('every scanned file is a TypeScript source file under src/', () => {
    for (const { file } of SCANNED) {
      expect(file.endsWith('.ts')).toBe(true);
      expect(file).toMatch(/^src[\\/]/);
    }
  });
});

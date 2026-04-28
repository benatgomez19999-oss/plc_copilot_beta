// Sprint 62 — pure tests for the publish-dry-run helper lib. The real
// `npm publish --dry-run --json` is exercised by the runner in
// pnpm release:publish-dry-run; here we only test parser, command
// builder, and validator semantics.
//
// (Single-line comments because a JSDoc would close on `*/` inside an
// `@plccopilot/...` package path — same gotcha noted in release-plan.spec.ts.)

import { describe, expect, it } from 'vitest';

import {
  buildPublishDryRunCommand,
  checkPublishDryRunResult,
  checkPublishDryRunSpawn,
  isAlreadyPublishedError,
  isDryRunCommand,
  parsePublishDryRunOutput,
} from '../scripts/release-publish-dry-run-lib.mjs';

const expected = { name: '@plccopilot/cli', version: '0.1.0' };

const cleanJson = `{
  "id": "@plccopilot/cli@0.1.0",
  "name": "@plccopilot/cli",
  "version": "0.1.0",
  "filename": "plccopilot-cli-0.1.0.tgz",
  "files": [
    { "path": "package.json", "size": 1234, "mode": 420 },
    { "path": "dist/index.js", "size": 1024, "mode": 420 }
  ]
}
`;

describe('buildPublishDryRunCommand', () => {
  it('always includes publish --dry-run --json in that order', () => {
    const cmd = buildPublishDryRunCommand();
    expect(cmd.cmd).toBe('npm');
    expect(cmd.args.slice(0, 3)).toEqual(['publish', '--dry-run', '--json']);
  });

  it('isDryRunCommand recognises the hardcoded shape', () => {
    expect(isDryRunCommand(buildPublishDryRunCommand())).toBe(true);
  });

  it('appends forwarded args after the dry-run trio', () => {
    const cmd = buildPublishDryRunCommand(['--access', 'public']);
    expect(cmd.args).toEqual(['publish', '--dry-run', '--json', '--access', 'public']);
  });

  it('refuses --no-dry-run forwarded arg', () => {
    expect(() => buildPublishDryRunCommand(['--no-dry-run'])).toThrow(/dry-run only/i);
  });

  it('refuses --publish / --yes / -y forwarded arg', () => {
    expect(() => buildPublishDryRunCommand(['--publish'])).toThrow(/dry-run only/i);
    expect(() => buildPublishDryRunCommand(['--yes'])).toThrow(/dry-run only/i);
    expect(() => buildPublishDryRunCommand(['-y'])).toThrow(/dry-run only/i);
  });

  it('rejects non-array forwardArgs', () => {
    expect(() => buildPublishDryRunCommand('--dry-run' as any)).toThrow(/array/);
  });

  it('rejects non-string forwarded args', () => {
    expect(() => buildPublishDryRunCommand([42 as any])).toThrow(/strings/);
  });
});

describe('parsePublishDryRunOutput', () => {
  it('parses clean JSON object', () => {
    const r = parsePublishDryRunOutput(cleanJson);
    expect(r?.name).toBe('@plccopilot/cli');
    expect(r?.version).toBe('0.1.0');
    expect(Array.isArray(r?.files)).toBe(true);
  });

  it('tolerates leading npm warn / npm notice lines before JSON', () => {
    const stdout =
      'npm warn This command requires you to be logged in (dry-run)\n' +
      'npm notice Publishing to https://registry.npmjs.org/ (dry-run)\n' +
      cleanJson;
    const r = parsePublishDryRunOutput(stdout);
    expect(r?.name).toBe('@plccopilot/cli');
  });

  it('returns null on empty input', () => {
    expect(parsePublishDryRunOutput('')).toBeNull();
    expect(parsePublishDryRunOutput(undefined as any)).toBeNull();
  });

  it('returns null when no JSON object is present', () => {
    expect(parsePublishDryRunOutput('not json at all')).toBeNull();
  });

  it('returns null on syntactically broken JSON tail', () => {
    expect(parsePublishDryRunOutput('npm warn foo\n{ "name": "@plccopilot/cli" ')).toBeNull();
  });
});

describe('checkPublishDryRunResult', () => {
  it('passes a clean result', () => {
    const parsed = parsePublishDryRunOutput(cleanJson);
    expect(checkPublishDryRunResult(parsed, expected)).toEqual([]);
  });

  it('emits PUBLISH_DRY_RUN_NO_JSON for null', () => {
    const codes = checkPublishDryRunResult(null, expected).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_NO_JSON');
  });

  it('emits PUBLISH_DRY_RUN_NAME_MISMATCH', () => {
    const codes = checkPublishDryRunResult(
      { name: '@bad/name', version: '0.1.0', files: [{ path: 'x' }] },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_NAME_MISMATCH');
  });

  it('emits PUBLISH_DRY_RUN_VERSION_MISMATCH', () => {
    const codes = checkPublishDryRunResult(
      { name: '@plccopilot/cli', version: '0.0.9', files: [{ path: 'x' }] },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_VERSION_MISMATCH');
  });

  it('emits PUBLISH_DRY_RUN_NO_FILES on empty files[]', () => {
    const codes = checkPublishDryRunResult(
      { name: '@plccopilot/cli', version: '0.1.0', files: [] },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_NO_FILES');
  });
});

describe('checkPublishDryRunSpawn', () => {
  it('passes when status=0 + parseable JSON + matching name/version', () => {
    const issues = checkPublishDryRunSpawn(
      { status: 0, stdout: cleanJson, stderr: '' },
      expected,
    );
    expect(issues).toEqual([]);
  });

  it('emits PUBLISH_DRY_RUN_NONZERO when npm exited non-zero', () => {
    const codes = checkPublishDryRunSpawn(
      {
        status: 1,
        stdout: cleanJson,
        stderr: 'npm error something went wrong',
      },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_NONZERO');
  });

  it('emits PUBLISH_DRY_RUN_SPAWN_FAILED on spawn error', () => {
    const codes = checkPublishDryRunSpawn(
      {
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('spawn ENOENT'),
      },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_SPAWN_FAILED');
  });

  it('still surfaces JSON-shape problems alongside non-zero exit', () => {
    const codes = checkPublishDryRunSpawn(
      { status: 2, stdout: '', stderr: '' },
      expected,
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_NONZERO');
    expect(codes).toContain('PUBLISH_DRY_RUN_NO_JSON');
  });

  it('tolerates warnings on stderr when status=0', () => {
    const issues = checkPublishDryRunSpawn(
      {
        status: 0,
        stdout: cleanJson,
        stderr: 'npm warn This command requires you to be logged in (dry-run)\n',
      },
      expected,
    );
    expect(issues).toEqual([]);
  });

  // Sprint 67 closeout — post-publish behaviour.
  it('passes when npm reports the version is already on the registry', () => {
    // Real npm 11 output for a re-publish attempt of an existing version.
    const stderr =
      'npm warn publish npm auto-corrected some errors in your package.json...\n' +
      'npm error You cannot publish over the previously published versions: 0.1.0.\n';
    const stdout = '{ "error": { "summary": "You cannot publish over the previously published versions: 0.1.0." } }';
    const issues = checkPublishDryRunSpawn(
      { status: 1, stdout, stderr },
      expected,
    );
    expect(issues).toEqual([]);
  });

  it('keeps failing when "already published" message names a different version', () => {
    // 0.1.0 is on the registry but operator just bumped to 0.1.1; the
    // npm error referencing 0.1.0 must NOT silence a real conflict on
    // 0.1.1.
    const stderr = 'npm error You cannot publish over the previously published versions: 0.1.0.\n';
    const codes = checkPublishDryRunSpawn(
      { status: 1, stdout: '', stderr },
      { name: '@plccopilot/cli', version: '0.1.1' },
    ).map((i) => i.code);
    expect(codes).toContain('PUBLISH_DRY_RUN_NONZERO');
  });
});

describe('isAlreadyPublishedError', () => {
  it('matches the canonical npm message for the expected version', () => {
    expect(
      isAlreadyPublishedError(
        'npm error You cannot publish over the previously published versions: 0.1.0.',
        '',
        '0.1.0',
      ),
    ).toBe(true);
  });

  it('matches when the message is on stdout', () => {
    expect(
      isAlreadyPublishedError(
        '',
        'You cannot publish over the previously published versions: 0.1.0.',
        '0.1.0',
      ),
    ).toBe(true);
  });

  it('does NOT match when the published version differs from expected', () => {
    expect(
      isAlreadyPublishedError(
        'npm error You cannot publish over the previously published versions: 0.1.0.',
        '',
        '0.1.1',
      ),
    ).toBe(false);
  });

  it('does NOT match unrelated npm errors', () => {
    expect(
      isAlreadyPublishedError(
        'npm error 401 Unauthorized',
        '',
        '0.1.0',
      ),
    ).toBe(false);
  });

  it('returns false on empty input or non-string version', () => {
    expect(isAlreadyPublishedError('', '', '0.1.0')).toBe(false);
    expect(
      isAlreadyPublishedError('You cannot publish over the previously published versions: 0.1.0.', '', undefined as any),
    ).toBe(false);
  });
});

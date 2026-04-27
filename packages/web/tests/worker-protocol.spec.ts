import { describe, expect, it } from 'vitest';
import {
  isCompileWorkerRequest,
  isCompileWorkerResponse,
  makeRequestId,
  serializeError,
} from '../src/worker/protocol.js';

describe('makeRequestId', () => {
  it('produces strings prefixed with `req_`', () => {
    const id = makeRequestId();
    expect(id).toMatch(/^req_[a-z0-9]+_[a-z0-9]+$/);
  });

  it('two consecutive ids are distinct (monotonic counter)', () => {
    const a = makeRequestId();
    const b = makeRequestId();
    expect(a).not.toBe(b);
  });
});

describe('serializeError', () => {
  it('preserves message + stack on Error instances', () => {
    const e = new Error('boom');
    const out = serializeError(e);
    expect(out.message).toBe('boom');
    expect(out.stack).toContain('Error');
  });

  it('handles plain string throws', () => {
    expect(serializeError('string boom')).toEqual({ message: 'string boom' });
  });

  it('handles plain object throws with message + stack', () => {
    expect(
      serializeError({ message: 'obj boom', stack: 'fake stack' }),
    ).toEqual({ message: 'obj boom', stack: 'fake stack' });
  });

  it('handles object throws without message field via String() coercion', () => {
    expect(serializeError({ code: 7 })).toEqual({
      message: '[object Object]',
    });
  });

  it('handles undefined / null gracefully', () => {
    expect(serializeError(undefined).message).toBe('undefined');
    expect(serializeError(null).message).toBe('null');
  });

  it('does not include `stack` when the Error has none', () => {
    const e = new Error('no stack');
    e.stack = undefined;
    const out = serializeError(e);
    expect(out.message).toBe('no stack');
    expect('stack' in out).toBe(false);
  });
});

describe('isCompileWorkerRequest', () => {
  it('accepts a valid compile request', () => {
    expect(
      isCompileWorkerRequest({
        id: 'x',
        type: 'compile',
        project: {},
        backend: 'siemens',
      }),
    ).toBe(true);
  });

  it('rejects null / non-objects / wrong type field', () => {
    expect(isCompileWorkerRequest(null)).toBe(false);
    expect(isCompileWorkerRequest(undefined)).toBe(false);
    expect(isCompileWorkerRequest('string')).toBe(false);
    expect(isCompileWorkerRequest({ id: 'x', type: 'wrong' })).toBe(false);
    expect(isCompileWorkerRequest({ type: 'compile' })).toBe(false); // missing id
    expect(isCompileWorkerRequest({ id: 1, type: 'compile' })).toBe(false); // id not string
  });
});

describe('isCompileWorkerResponse', () => {
  it('accepts a valid success response', () => {
    expect(
      isCompileWorkerResponse({
        id: 'x',
        type: 'success',
        result: { backend: 'siemens', artifacts: [], diagnostics: [] },
      }),
    ).toBe(true);
  });

  it('accepts a valid error response', () => {
    expect(
      isCompileWorkerResponse({
        id: 'x',
        type: 'error',
        error: { message: 'boom' },
      }),
    ).toBe(true);
  });

  it('rejects an error response missing message', () => {
    expect(
      isCompileWorkerResponse({
        id: 'x',
        type: 'error',
        error: { stack: 'only stack' },
      }),
    ).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isCompileWorkerResponse(null)).toBe(false);
    expect(isCompileWorkerResponse({ id: 'x' })).toBe(false);
    expect(isCompileWorkerResponse({ id: 'x', type: 'success' })).toBe(false); // missing result
    expect(isCompileWorkerResponse({ id: 1, type: 'success', result: {} })).toBe(false);
  });
});

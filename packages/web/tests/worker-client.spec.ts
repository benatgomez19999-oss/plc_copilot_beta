import { describe, expect, it } from 'vitest';
import fixture from '../../pir/src/fixtures/weldline.json';
import type { Project } from '@plccopilot/pir';
import {
  CompileClientError,
  createCompileWorkerClient,
  type WorkerLike,
} from '../src/worker/client.js';
import type {
  CompileWorkerRequest,
  CompileWorkerResponse,
} from '../src/worker/protocol.js';
import { handleCompileRequest } from '../src/worker/handler.js';
import type { CompileResult } from '../src/compiler/compile.js';

function clone(): Project {
  return structuredClone(fixture) as unknown as Project;
}

// =============================================================================
// FakeWorker — captures postMessage payloads, lets the test trigger the
// onmessage / onerror callbacks. Implements `WorkerLike` exactly.
// =============================================================================

class FakeWorker implements WorkerLike {
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;

  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }

  // ---- Test helpers ----
  emit(response: CompileWorkerResponse): void {
    this.onmessage?.({ data: response });
  }
  emitNoise(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitError(message: string): void {
    this.onerror?.({ message });
  }
  lastRequest(): CompileWorkerRequest {
    return this.posted.at(-1) as CompileWorkerRequest;
  }
}

// =============================================================================
// Worker mode
// =============================================================================

describe('createCompileWorkerClient — worker mode', () => {
  it('reports `available: true` when the factory returns a worker', () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    expect(client.available).toBe(true);
    expect(client.fallbackReason).toBeNull();
  });

  it('posts a typed compile request with a fresh id', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const promise = client.compile(clone(), 'siemens', {
      generatedAt: '2026-04-26T00:00:00Z',
    });

    expect(fake.posted).toHaveLength(1);
    const req = fake.lastRequest();
    expect(req.type).toBe('compile');
    expect(req.id).toMatch(/^req_/);
    expect(req.backend).toBe('siemens');
    expect(req.generatedAt).toBe('2026-04-26T00:00:00Z');

    // Drive the round-trip with a real handler call so the result is realistic.
    const response = handleCompileRequest(req);
    fake.emit(response);
    const result = await promise;
    expect(result.backend).toBe('siemens');
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it('rejects the matching promise on an `error` response', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const promise = client.compile(clone(), 'siemens');
    const id = fake.lastRequest().id;
    fake.emit({
      id,
      type: 'error',
      error: { name: 'Error', message: 'simulated worker error' },
    });
    await expect(promise).rejects.toThrow(/simulated worker error/);
  });

  it('rejects with CompileClientError carrying the structured serialized payload', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const promise = client.compile(clone(), 'siemens');
    const id = fake.lastRequest().id;
    fake.emit({
      id,
      type: 'error',
      error: {
        name: 'CodegenError',
        code: 'UNKNOWN_PARAMETER',
        message: 'Recipe "r_default" references unknown parameter "p_x".',
        path: 'machines[0].recipes[0].values.p_x',
        symbol: 'p_x',
        hint: 'Define the parameter or remove the recipe entry.',
      },
    });
    try {
      await promise;
      throw new Error('expected reject');
    } catch (e) {
      expect(e).toBeInstanceOf(CompileClientError);
      const cce = e as CompileClientError;
      expect(cce.serialized.code).toBe('UNKNOWN_PARAMETER');
      expect(cce.serialized.symbol).toBe('p_x');
      expect(cce.message).toContain('[UNKNOWN_PARAMETER]');
      expect(cce.message).toContain('Recipe "r_default"');
      expect(cce.message).toContain('Hint: Define the parameter');
    }
  });

  it('ignores responses with unknown ids (stale / replay safety)', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const promise = client.compile(clone(), 'siemens');

    // Inject a noise message — not a valid response shape.
    fake.emitNoise({ id: 'wrong', type: 'success', result: 42 });
    fake.emitNoise({ totally: 'unrelated' });

    const id = fake.lastRequest().id;
    const response = handleCompileRequest(fake.lastRequest());
    fake.emit({ ...response, id }); // valid one with the real id

    const result = await promise;
    expect(result.backend).toBe('siemens');
  });

  it('rejects every pending request when the worker emits onerror', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const a = client.compile(clone(), 'siemens');
    const b = client.compile(clone(), 'codesys');
    fake.emitError('worker died');
    await expect(a).rejects.toThrow(/worker died/);
    await expect(b).rejects.toThrow(/worker died/);
  });

  it('terminate() stops the worker and rejects pending requests', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const promise = client.compile(clone(), 'siemens');
    client.terminate();
    expect(fake.terminated).toBe(true);
    await expect(promise).rejects.toThrow(/terminated/);
  });

  it('two concurrent requests resolve independently by id', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const a = client.compile(clone(), 'siemens');
    const b = client.compile(clone(), 'codesys');

    const [reqA, reqB] = fake.posted as CompileWorkerRequest[];
    expect(reqA!.id).not.toBe(reqB!.id);

    // Resolve B first, then A — out of order.
    fake.emit(handleCompileRequest(reqB!));
    fake.emit(handleCompileRequest(reqA!));

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA.backend).toBe('siemens');
    expect(resB.backend).toBe('codesys');
  });
});

// =============================================================================
// Fallback mode
// =============================================================================

describe('createCompileWorkerClient — fallback mode', () => {
  it('reports `available: false` when the factory returns null', () => {
    const client = createCompileWorkerClient({ workerFactory: () => null });
    expect(client.available).toBe(false);
    expect(client.fallbackReason).toMatch(/Web Worker unavailable/);
  });

  it('reports `available: false` when the factory throws', () => {
    const client = createCompileWorkerClient({
      workerFactory: () => {
        throw new Error('CSP blocked');
      },
    });
    expect(client.available).toBe(false);
    expect(client.fallbackReason).toMatch(/CSP blocked/);
  });

  it('compile() routes to the main-thread fallback', async () => {
    const stub: CompileResult = {
      backend: 'siemens',
      artifacts: [],
      diagnostics: [],
      summary: { artifactCount: 0, errors: 0, warnings: 0, info: 0 },
    };
    let calls = 0;
    const client = createCompileWorkerClient({
      workerFactory: () => null,
      mainThreadFallback: () => {
        calls += 1;
        return stub;
      },
    });
    const result = await client.compile(clone(), 'siemens');
    expect(calls).toBe(1);
    expect(result).toBe(stub);
  });

  it('propagates fallback errors as rejected promises', async () => {
    const client = createCompileWorkerClient({
      workerFactory: () => null,
      mainThreadFallback: () => {
        throw new Error('main-thread compile failed');
      },
    });
    await expect(client.compile(clone(), 'siemens')).rejects.toThrow(
      /main-thread compile failed/,
    );
  });
});

// =============================================================================
// Handler — round-trips end to end without a real worker
// =============================================================================

describe('handleCompileRequest — round-trip', () => {
  it('returns success on the canonical fixture', () => {
    const response = handleCompileRequest({
      id: 'r1',
      type: 'compile',
      project: clone(),
      backend: 'siemens',
    });
    expect(response.id).toBe('r1');
    expect(response.type).toBe('success');
    if (response.type === 'success') {
      expect(response.result.backend).toBe('siemens');
      expect(response.result.artifacts.length).toBeGreaterThan(0);
    }
  });

  it('serialises CodegenError into the structured shape (sprint 39 / 86)', () => {
    // Construct a project whose first machine has unsupported equipment.
    // Sprint 86 — the codegen readiness preflight runs before
    // `compileProject` and rolls every blocking diagnostic up into a
    // single `READINESS_FAILED` CodegenError. The original
    // UNSUPPORTED_EQUIPMENT throw still fires when `compileProject` is
    // called outside the target façade (covered by codegen-core).
    const broken = clone();
    (broken.machines[0]!.stations[0]!.equipment[0]!.type as string) =
      'valve_onoff_unsupported';
    const response = handleCompileRequest({
      id: 'r2',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error.name).toBe('CodegenError');
      expect(response.error.code).toBe('READINESS_FAILED');
      expect(typeof response.error.message).toBe('string');
      // Stack stays out of the default UX.
      expect(response.error.stack).toBeUndefined();
    }
  });

  it('round-trips UNKNOWN_PARAMETER with code + recipe + param + hint', () => {
    // Add a ghost-param recipe entry so DB_Recipes throws.
    const broken = clone();
    const recipe = broken.machines[0]!.recipes[0]!;
    (recipe.values as Record<string, number | boolean>).p_ghost_param = 1;
    const response = handleCompileRequest({
      id: 'r3',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error.code).toBe('UNKNOWN_PARAMETER');
      expect(response.error.message).toContain('p_ghost_param');
      expect(response.error.symbol).toBe('p_ghost_param');
      expect(response.error.hint).toContain('Define the parameter');
      expect(response.error.path).toContain('recipes[');
    }
  });

  it('round-trips READINESS_FAILED with stationId + symbol + path + hint (sprint 40 / 86)', () => {
    // Sprint 86 — preflight runs before compileProject. The wrapper
    // CodegenError carries the first blocking diagnostic's metadata
    // (path / stationId / symbol / hint) so the existing UX surface is
    // preserved; only the top-level `code` changed.
    const broken = clone();
    (broken.machines[0]!.stations[0]!.equipment[0]!.type as string) =
      'valve_onoff_unsupported';
    const response = handleCompileRequest({
      id: 'r4',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error.code).toBe('READINESS_FAILED');
      expect(response.error.path).toBe(
        'machines[0].stations[0].equipment[0].type',
      );
      // Pulled straight from the PIR fixture — first station is `st_load`.
      expect(response.error.stationId).toBe(
        broken.machines[0]!.stations[0]!.id,
      );
      expect(response.error.symbol).toBe(
        broken.machines[0]!.stations[0]!.equipment[0]!.id,
      );
      expect(response.error.hint).toMatch(/pneumatic_cylinder_2pos/);
      // Stack stays out of the default UX.
      expect(response.error.stack).toBeUndefined();
    }
  });

  it('surfaces alarm.when diagnostics in manifest compiler_diagnostics (sprint 44)', async () => {
    const broken = clone();
    broken.machines[0]!.alarms[0]!.when = 'unknown_func(1)';
    const response = handleCompileRequest({
      id: 's44',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    // Without `strictDiagnostics`, alarm errors stay informational
    // — the compile succeeds and the diagnostic rides the manifest.
    expect(response.type).toBe('success');
    if (response.type === 'success') {
      const { diagnosticsFromGeneratedArtifacts } = await import(
        '../src/utils/diagnostics.js'
      );
      const all = diagnosticsFromGeneratedArtifacts(response.result.artifacts);
      const alarmDiag = all.find(
        (d) =>
          d.code === 'UNKNOWN_FUNCTION' &&
          d.path === 'machines[0].alarms[0].when',
      );
      expect(alarmDiag).toBeDefined();
      expect(alarmDiag!.symbol).toBe(broken.machines[0]!.alarms[0]!.id);
      expect(alarmDiag!.hint).toMatch(/alarm condition/);
    }
  });

  it('round-trips a transition.guard expression error with the guard JSON path (sprint 43)', () => {
    const broken = clone();
    const station = broken.machines[0]!.stations[0]!;
    const ti = station.sequence.transitions.findIndex((t) => t.from !== '*');
    expect(ti).toBeGreaterThanOrEqual(0);
    station.sequence.transitions[ti]!.guard = 'unknown_func(1)';
    const response = handleCompileRequest({
      id: 's43',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error.code).toBe('UNKNOWN_FUNCTION');
      expect(response.error.path).toBe(
        `machines[0].stations[0].sequence.transitions[${ti}].guard`,
      );
      expect(response.error.stationId).toBe(station.id);
      expect(response.error.symbol).toBe(
        station.sequence.transitions[ti]!.id,
      );
      expect(response.error.hint).toMatch(/transition guard/);
      expect(response.error.stack).toBeUndefined();
    }
  });

  it('client rejects transition.guard error with formatted message + serialized path', async () => {
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const broken = clone();
    const station = broken.machines[0]!.stations[0]!;
    const ti = station.sequence.transitions.findIndex((t) => t.from !== '*');
    station.sequence.transitions[ti]!.guard = 'unknown_func(1)';
    const promise = client.compile(broken, 'siemens');
    const req = fake.lastRequest();
    fake.emit(handleCompileRequest(req));
    try {
      await promise;
      throw new Error('expected reject');
    } catch (e) {
      expect(e).toBeInstanceOf(CompileClientError);
      const cce = e as CompileClientError;
      expect(cce.serialized.code).toBe('UNKNOWN_FUNCTION');
      expect(cce.serialized.path).toBe(
        `machines[0].stations[0].sequence.transitions[${ti}].guard`,
      );
      expect(cce.message).toContain('[UNKNOWN_FUNCTION]');
      // Single-line by formatter contract.
      expect(cce.message.split('\n')).toHaveLength(1);
    }
  });

  it('round-trips UNKNOWN_STATE with the transition.to JSON path (sprint 42)', () => {
    const broken = clone();
    const station = broken.machines[0]!.stations[0]!;
    const ti = station.sequence.transitions.findIndex((t) => t.from !== '*');
    expect(ti).toBeGreaterThanOrEqual(0);
    station.sequence.transitions[ti]!.to = 'state_does_not_exist';
    const response = handleCompileRequest({
      id: 's42',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error.code).toBe('UNKNOWN_STATE');
      expect(response.error.path).toBe(
        `machines[0].stations[0].sequence.transitions[${ti}].to`,
      );
      expect(response.error.symbol).toBe('state_does_not_exist');
      expect(response.error.hint).toBeDefined();
      expect(response.error.stack).toBeUndefined();
    }
  });

  it('round-trips UNSUPPORTED_ACTIVITY with stationId + symbol + hint (sprint 41)', () => {
    const broken = clone();
    const station = broken.machines[0]!.stations[0]!;
    const eqId = station.equipment[0]!.id;
    // Reference an activity the equipment type does not support.
    station.sequence.states[0]!.activity = {
      activate: [`${eqId}.bogus_activity`],
    };
    const response = handleCompileRequest({
      id: 's41',
      type: 'compile',
      project: broken,
      backend: 'siemens',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.error.code).toBe('UNSUPPORTED_ACTIVITY');
      expect(response.error.stationId).toBe(station.id);
      expect(response.error.symbol).toBe(`${eqId}.bogus_activity`);
      expect(response.error.hint).toBeDefined();
      expect(response.error.hint!.length).toBeGreaterThan(0);
      // Stack stays out of the default UX.
      expect(response.error.stack).toBeUndefined();
    }
  });

  it('client rejects READINESS_FAILED with formatted CompileClientError (sprint 40 / 86)', async () => {
    // Sprint 86 — preflight wraps unsupported equipment into
    // READINESS_FAILED before the wrapped error reaches the worker
    // protocol. The CompileClientError formatter still produces a
    // single-line message with the `[CODE]` prefix and `Hint: …`
    // tail; only the top-level code changed.
    const fake = new FakeWorker();
    const client = createCompileWorkerClient({ workerFactory: () => fake });
    const broken = clone();
    (broken.machines[0]!.stations[0]!.equipment[0]!.type as string) =
      'valve_onoff_unsupported';
    const promise = client.compile(broken, 'siemens');
    const req = fake.lastRequest();
    fake.emit(handleCompileRequest(req));
    try {
      await promise;
      throw new Error('expected reject');
    } catch (e) {
      expect(e).toBeInstanceOf(CompileClientError);
      const cce = e as CompileClientError;
      expect(cce.serialized.code).toBe('READINESS_FAILED');
      expect(cce.message).toContain('[READINESS_FAILED]');
      expect(cce.message).toMatch(/Hint: /);
      // The formatter is single-line by contract — the rolled-up
      // diagnostic body lives in the message *before* the path /
      // hint suffix, so newlines must be stripped by the formatter.
      expect(cce.message.split('\n')).toHaveLength(1);
    }
  });
});

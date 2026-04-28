// Sprint 72 — pure tests for the EPLAN-stub ingestor + the source
// registry. The stub ingestor MUST NOT throw and MUST report the
// situation honestly via diagnostics.

import { describe, expect, it } from 'vitest';

import {
  createDefaultSourceRegistry,
  createSourceRegistry,
  ingestWithRegistry,
} from '../src/sources/generic.js';
import { createUnsupportedEplanIngestor } from '../src/sources/eplan.js';
import type { EplanIngestionInput } from '../src/types.js';

describe('createUnsupportedEplanIngestor', () => {
  const ing = createUnsupportedEplanIngestor();

  it('canIngest returns true for known file kinds', () => {
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [{ path: 'a.xml', kind: 'xml' }],
      }),
    ).toBe(true);
    expect(
      ing.canIngest({
        sourceId: 's',
        files: [
          { path: 'a.xml', kind: 'xml' },
          { path: 'b.csv', kind: 'csv' },
        ],
      }),
    ).toBe(true);
  });

  it('canIngest returns false for empty / non-array files', () => {
    expect(ing.canIngest({ sourceId: 's', files: [] })).toBe(false);
    expect(ing.canIngest(null as any)).toBe(false);
    expect(ing.canIngest({ sourceId: 's', files: null as any })).toBe(false);
  });

  it('ingest does NOT throw and returns an empty graph + UNSUPPORTED diagnostic', async () => {
    const input: EplanIngestionInput = {
      sourceId: 'src-1',
      files: [{ path: 'plan.xml', kind: 'xml' }],
    };
    const result = await ing.ingest(input);
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.edges).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === 'UNSUPPORTED_SOURCE_FEATURE'),
    ).toBe(true);
    expect(result.graph.metadata.sourceFiles).toEqual(['plan.xml']);
    expect(result.graph.metadata.generator).toBe(
      'electrical-ingest@unsupported-stub',
    );
  });

  it('ingest emits one UNSUPPORTED diagnostic per file at info severity', async () => {
    const input: EplanIngestionInput = {
      sourceId: 'src-2',
      files: [
        { path: 'a.xml', kind: 'xml' },
        { path: 'b.pdf', kind: 'pdf' },
      ],
    };
    const result = await ing.ingest(input);
    const fileDiags = result.diagnostics.filter(
      (d) =>
        d.code === 'UNSUPPORTED_SOURCE_FEATURE' &&
        d.severity === 'info' &&
        d.sourceRef !== undefined,
    );
    expect(fileDiags.length).toBe(2);
    expect(fileDiags.map((d) => d.sourceRef?.path).sort()).toEqual(['a.xml', 'b.pdf']);
  });
});

describe('createSourceRegistry', () => {
  it('returns a fresh registry with no ingestors', () => {
    const reg = createSourceRegistry();
    expect(reg.list()).toEqual([]);
    expect(
      reg.resolve({ sourceId: 's', files: [{ path: 'a.xml', kind: 'xml' }] }),
    ).toBeNull();
  });

  it('register + resolve returns the matching ingestor', () => {
    const reg = createSourceRegistry();
    const ing = createUnsupportedEplanIngestor();
    reg.register(ing);
    expect(reg.list().length).toBe(1);
    expect(
      reg.resolve({ sourceId: 's', files: [{ path: 'a.xml', kind: 'xml' }] }),
    ).toBe(ing);
  });

  it('register rejects malformed ingestors', () => {
    const reg = createSourceRegistry();
    expect(() => reg.register(null as any)).toThrow();
    expect(() => reg.register({} as any)).toThrow();
  });

  it('resolve treats throwing canIngest as "no"', () => {
    const reg = createSourceRegistry();
    const evil = {
      canIngest: () => {
        throw new Error('boom');
      },
      ingest: async () => {
        throw new Error('unreachable');
      },
    } as any;
    reg.register(evil);
    expect(
      reg.resolve({ sourceId: 's', files: [{ path: 'a.xml', kind: 'xml' }] }),
    ).toBeNull();
  });
});

describe('createDefaultSourceRegistry', () => {
  it('comes pre-loaded with CSV + EPLAN-XML + EPLAN unsupported stub (Sprint 74)', () => {
    const reg = createDefaultSourceRegistry();
    // Sprint 72: 1 ingestor (unsupported stub).
    // Sprint 73: +CSV → 2.
    // Sprint 74: +EPLAN XML → 3.
    expect(reg.list().length).toBe(3);
    // CSV input resolves to the CSV ingestor.
    const resolvedCsv = reg.resolve({
      sourceId: 's',
      files: [{ path: 'a.csv', kind: 'csv', content: 'tag,kind\nB1,sensor\n' }],
    });
    expect(resolvedCsv).not.toBeNull();
    // XML input with content resolves to the EPLAN XML ingestor.
    const resolvedXml = reg.resolve({
      sourceId: 's',
      files: [{ path: 'a.xml', kind: 'xml', content: '<EplanProject/>' }],
    });
    expect(resolvedXml).not.toBeNull();
    // edz still falls through to the unsupported stub.
    const resolvedEdz = reg.resolve({
      sourceId: 's',
      files: [{ path: 'a.edz', kind: 'edz' }],
    });
    expect(resolvedEdz).not.toBeNull();
  });
});

describe('ingestWithRegistry', () => {
  it('falls through to the unsupported stub when no ingestor matches', async () => {
    const reg = createSourceRegistry();
    const result = await ingestWithRegistry(reg, {
      sourceId: 's',
      files: [{ path: 'a.xml', kind: 'xml' }],
    });
    expect(
      result.diagnostics.some((d) => d.code === 'UNSUPPORTED_SOURCE_FEATURE'),
    ).toBe(true);
    expect(result.graph.nodes).toEqual([]);
  });

  it('uses a registered ingestor when canIngest matches', async () => {
    const reg = createSourceRegistry();
    let called = 0;
    reg.register({
      canIngest: () => true,
      ingest: async (_input) => {
        called++;
        return {
          graph: {
            id: 'g',
            sourceKind: 'manual',
            nodes: [],
            edges: [],
            diagnostics: [],
            metadata: {},
          },
          diagnostics: [],
        };
      },
    });
    await ingestWithRegistry(reg, {
      sourceId: 's',
      files: [{ path: 'x.xml', kind: 'xml' }],
    });
    expect(called).toBe(1);
  });
});

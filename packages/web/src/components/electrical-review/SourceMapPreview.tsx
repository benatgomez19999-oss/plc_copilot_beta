// Sprint 77 — sidecar source-map preview. The Sprint 76 builder
// returns `result.sourceMap[<pirId>] → SourceRef[]` so the operator
// can trace any PIR object back to the CSV row or EPLAN element it
// came from. This component renders that mapping.

import { useState } from 'react';
import type { PirBuildResult } from '@plccopilot/electrical-ingest';

import { SourceRefPanel } from './SourceRefPanel.js';

export interface SourceMapPreviewProps {
  result: PirBuildResult | null;
}

export function SourceMapPreview({ result }: SourceMapPreviewProps): JSX.Element {
  if (!result || !result.sourceMap) {
    return (
      <section className="source-map-preview source-map-preview--empty" aria-label="Source evidence map">
        <p className="muted">
          No source map yet. Build a PIR preview to populate the
          source-evidence sidecar.
        </p>
      </section>
    );
  }
  const entries = Object.entries(result.sourceMap);
  if (entries.length === 0) {
    return (
      <section className="source-map-preview" aria-label="Source evidence map">
        <p className="muted">
          The builder emitted no source-map entries. This usually
          means the build was refused before any PIR object was
          produced — see the build diagnostics.
        </p>
      </section>
    );
  }
  return (
    <section className="source-map-preview" aria-label="Source evidence map">
      <header className="panel-header">
        <h3>Source evidence (sourceMap)</h3>
        <span className="badge" role="status">
          {entries.length} PIR object{entries.length === 1 ? '' : 's'} traced
        </span>
      </header>
      <p className="muted">
        Each row maps a PIR id (left) to the originating
        <code> SourceRef </code> entries (right). CSV refs show
        line + path; EPLAN refs additionally carry the XML locator
        in <code>symbol</code>.
      </p>
      <ul className="source-map-list">
        {entries.map(([pirId, refs]) => (
          <SourceMapRow key={pirId} pirId={pirId} refs={refs} />
        ))}
      </ul>
    </section>
  );
}

interface SourceMapRowProps {
  pirId: string;
  refs: ReadonlyArray<PirBuildResult['sourceMap'][string][number]>;
}

function SourceMapRow({ pirId, refs }: SourceMapRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="source-map-row">
      <header className="source-map-row-header">
        <code className="source-map-pir-id">{pirId}</code>
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-controls={`source-map-${pirId}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {refs.length === 0
            ? 'No source evidence'
            : expanded
              ? `Hide ${refs.length} source${refs.length === 1 ? '' : 's'}`
              : `Show ${refs.length} source${refs.length === 1 ? '' : 's'}`}
        </button>
      </header>
      {expanded ? (
        <div id={`source-map-${pirId}`} className="source-map-row-body">
          <SourceRefPanel
            refs={refs}
            ariaLabel={`Source evidence for PIR object ${pirId}`}
          />
        </div>
      ) : null}
    </li>
  );
}

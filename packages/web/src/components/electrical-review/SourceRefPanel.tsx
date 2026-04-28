// Sprint 75 — source-ref drilldown. Renders whatever fields the
// summarizeSourceRef helper produces; missing optional fields are
// silently omitted instead of being rendered as "undefined".

import type { SourceRef } from '@plccopilot/electrical-ingest';

import {
  groupSourceRefsByKind,
  type SourceRefSummary,
} from '../../utils/review-source-refs.js';

export interface SourceRefPanelProps {
  refs: ReadonlyArray<SourceRef>;
  /** Optional aria-label for the surrounding section. */
  ariaLabel?: string;
}

export function SourceRefPanel({
  refs,
  ariaLabel,
}: SourceRefPanelProps): JSX.Element {
  if (!Array.isArray(refs) || refs.length === 0) {
    return (
      <section
        className="source-ref-panel source-ref-panel--empty"
        aria-label={ariaLabel ?? 'Source evidence'}
      >
        <p className="muted">
          <strong>No source evidence.</strong> This item has no traceable
          source — review whether the candidate should exist at all.
        </p>
      </section>
    );
  }
  const groups = groupSourceRefsByKind(refs);
  return (
    <section className="source-ref-panel" aria-label={ariaLabel ?? 'Source evidence'}>
      {groups.map((group) => (
        <div key={group.kind} className="source-ref-group">
          <h4 className="source-ref-group-title">
            <span className={`badge source-${group.kind}`}>{group.kind}</span>
            <span className="muted">
              ({group.refs.length} ref{group.refs.length === 1 ? '' : 's'})
            </span>
          </h4>
          <ul className="source-ref-list">
            {group.refs.map((s) => (
              <SourceRefRow key={s.key} summary={s} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function SourceRefRow({ summary }: { summary: SourceRefSummary }): JSX.Element {
  return (
    <li className="source-ref-row">
      <p className="source-ref-oneliner">{summary.oneLiner}</p>
      {summary.fields.length > 0 ? (
        <dl className="source-ref-fields">
          {summary.fields.map((f) => (
            <div key={f.key} className="source-ref-field">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

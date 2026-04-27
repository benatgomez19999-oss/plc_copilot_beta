import { Fragment, type ReactNode } from 'react';

export interface KeyValueRow {
  key: string;
  value: ReactNode;
}

export interface KeyValueGridProps {
  rows: KeyValueRow[];
}

/**
 * Two-column key/value display. Implemented with `<dl>` so screen readers
 * announce term/definition pairs; CSS turns it into a grid.
 */
export function KeyValueGrid({ rows }: KeyValueGridProps): JSX.Element {
  if (rows.length === 0) {
    return <p className="muted small">No fields.</p>;
  }
  return (
    <dl className="kv-grid">
      {rows.map((r, i) => (
        <Fragment key={`${r.key}-${i}`}>
          <dt>{r.key}</dt>
          <dd>{r.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

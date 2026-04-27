import type { ReactNode } from 'react';

export interface DetailSectionProps {
  title: string;
  /** Optional count shown faintly next to the title (`Alarms (3)`). */
  count?: number;
  children: ReactNode;
}

/**
 * Section wrapper used by every per-kind detail component. Keeps spacing /
 * heading style consistent without each component re-implementing it.
 */
export function DetailSection({
  title,
  count,
  children,
}: DetailSectionProps): JSX.Element {
  return (
    <section className="detail-section">
      <h4 className="detail-section-title">
        {title}
        {typeof count === 'number' ? (
          <span className="muted small"> ({count})</span>
        ) : null}
      </h4>
      {children}
    </section>
  );
}

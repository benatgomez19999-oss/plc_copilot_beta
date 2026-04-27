import type { ReactNode } from 'react';

export interface ToolbarProps {
  children: ReactNode;
}

export function Toolbar({ children }: ToolbarProps): JSX.Element {
  return <div className="toolbar">{children}</div>;
}

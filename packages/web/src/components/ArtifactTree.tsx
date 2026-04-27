import type { GeneratedArtifact } from '@plccopilot/codegen-core';

export interface ArtifactTreeProps {
  artifacts: readonly GeneratedArtifact[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface Group {
  dir: string;
  items: GeneratedArtifact[];
}

function groupByTopDir(
  artifacts: readonly GeneratedArtifact[],
): Group[] {
  const map = new Map<string, GeneratedArtifact[]>();
  for (const a of artifacts) {
    const idx = a.path.indexOf('/');
    const dir = idx >= 0 ? a.path.slice(0, idx) : '';
    const arr = map.get(dir);
    if (arr) arr.push(a);
    else map.set(dir, [a]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, items]) => ({
      dir,
      items: items.slice().sort((a, b) => a.path.localeCompare(b.path)),
    }));
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function ArtifactTree({
  artifacts,
  selectedPath,
  onSelect,
}: ArtifactTreeProps): JSX.Element {
  if (artifacts.length === 0) {
    return <p className="muted">No artifacts.</p>;
  }
  const groups = groupByTopDir(artifacts);

  return (
    <nav className="artifact-tree" aria-label="Generated artifacts">
      {groups.map(({ dir, items }) => (
        <details key={dir || '_root'} open>
          <summary>
            {dir || '(root)'}
            <span className="muted"> · {items.length}</span>
          </summary>
          <ul>
            {items.map((a) => (
              <li key={a.path}>
                <button
                  type="button"
                  onClick={() => onSelect(a.path)}
                  className={`tree-item ${selectedPath === a.path ? 'active' : ''}`}
                  title={a.path}
                >
                  <span className={`kind kind-${a.kind}`}>{a.kind}</span>
                  <span>{basename(a.path)}</span>
                  {a.diagnostics && a.diagnostics.length > 0 ? (
                    <span className="muted"> · {a.diagnostics.length}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </nav>
  );
}

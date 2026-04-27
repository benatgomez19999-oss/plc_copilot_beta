import { useState } from 'react';
import type { Project } from '@plccopilot/pir';
import { copyText } from '../utils/clipboard.js';
import type { PirStructureNode } from '../utils/pir-structure.js';
import type { PirDiffEntry } from '../utils/pir-diff.js';
import { ProjectDetails } from './details/ProjectDetails.js';
import { MachineDetails } from './details/MachineDetails.js';
import { StationDetails } from './details/StationDetails.js';
import { EquipmentDetails } from './details/EquipmentDetails.js';

export interface PirStructureDetailsProps {
  /** The applied project, or `null` when no PIR has been loaded yet. */
  project: Project | null;
  /** Currently selected structure node, or `null` when nothing is selected. */
  node: PirStructureNode | null;
  /**
   * Asks the parent to focus the JSONPath in the PIR editor. The parent
   * bumps a nonce so re-clicking the same node still scrolls Monaco.
   */
  onFocusInEditor: (jsonPath: string) => void;
  /**
   * Visual-edit hook. Detail components call this with a JSONPath relative
   * to the project (`$.machines[0].name`, …) and the new value. The parent
   * applies the patch to the draft JSON; the applied project is unchanged.
   */
  onPatch: (path: string, value: string) => void;
  /**
   * Optional pending-change list. Empty / undefined means "no diff" — the
   * detail components render their normal layout without a Pending
   * changes section.
   */
  diffs?: PirDiffEntry[];
}

type CopyState = 'idle' | 'ok' | 'fail';

/**
 * Right-hand pane of the PIR Structure card. Renders a per-kind detail
 * component (Project / Machine / Station / Equipment) with a shared header
 * carrying the kind badge, label, JSONPath, and Copy / Find buttons.
 *
 * Strictly read-only — no inline edit, no schema mutation. The PIR JSON
 * editor remains the only editing surface.
 */
export function PirStructureDetails({
  project,
  node,
  onFocusInEditor,
  onPatch,
  diffs,
}: PirStructureDetailsProps): JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  if (!node) {
    return (
      <div className="structure-details empty">
        <p className="muted">
          Select a node in the tree to inspect its details and JSONPath.
        </p>
      </div>
    );
  }

  async function handleCopy(): Promise<void> {
    if (!node) return;
    const ok = await copyText(node.jsonPath);
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <div className="structure-details">
      <header className="structure-details-header">
        <span className={`kind-badge kind-${node.kind}`}>
          {node.kind.toUpperCase()}
        </span>
        <h3>{node.label}</h3>
      </header>

      <p className="structure-jsonpath">
        <span className="muted small">JSONPath</span>
        <code>{node.jsonPath}</code>
      </p>

      <div className="preview-actions">
        <button type="button" className="btn" onClick={handleCopy}>
          {copyState === 'idle'
            ? 'Copy JSONPath'
            : copyState === 'ok'
              ? 'Copied ✓'
              : 'Copy failed'}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => onFocusInEditor(node.jsonPath)}
          title="Scroll the PIR editor to the matching line"
        >
          Find in PIR editor
        </button>
      </div>

      <DetailBody
        project={project}
        node={node}
        onPatch={onPatch}
        diffs={diffs}
        onFocusInEditor={onFocusInEditor}
      />
    </div>
  );
}

function DetailBody({
  project,
  node,
  onPatch,
  diffs,
  onFocusInEditor,
}: {
  project: Project | null;
  node: PirStructureNode;
  onPatch: (path: string, value: string) => void;
  diffs?: PirDiffEntry[];
  onFocusInEditor: (jsonPath: string) => void;
}): JSX.Element | null {
  if (!project) {
    return (
      <p className="muted small">
        No applied project — load a PIR first to see resolved details.
      </p>
    );
  }

  switch (node.kind) {
    case 'project':
      return (
        <ProjectDetails
          project={project}
          onPatch={onPatch}
          diffs={diffs}
          onFindInEditor={onFocusInEditor}
        />
      );

    case 'machine': {
      const mi = node.refs?.machineIndex;
      if (typeof mi !== 'number') return <MissingRefs />;
      return (
        <MachineDetails
          project={project}
          machineIndex={mi}
          onPatch={onPatch}
          diffs={diffs}
          onFindInEditor={onFocusInEditor}
        />
      );
    }

    case 'station': {
      const mi = node.refs?.machineIndex;
      const si = node.refs?.stationIndex;
      if (typeof mi !== 'number' || typeof si !== 'number') {
        return <MissingRefs />;
      }
      return (
        <StationDetails
          project={project}
          machineIndex={mi}
          stationIndex={si}
          onPatch={onPatch}
          diffs={diffs}
          onFindInEditor={onFocusInEditor}
        />
      );
    }

    case 'equipment': {
      const mi = node.refs?.machineIndex;
      const si = node.refs?.stationIndex;
      const ei = node.refs?.equipmentIndex;
      if (
        typeof mi !== 'number' ||
        typeof si !== 'number' ||
        typeof ei !== 'number'
      ) {
        return <MissingRefs />;
      }
      return (
        <EquipmentDetails
          project={project}
          machineIndex={mi}
          stationIndex={si}
          equipmentIndex={ei}
          onPatch={onPatch}
          diffs={diffs}
          onFindInEditor={onFocusInEditor}
        />
      );
    }
  }
}

function MissingRefs(): JSX.Element {
  return (
    <p className="muted small">
      This node has no resolvable refs — the underlying record may have been
      removed since it was selected.
    </p>
  );
}

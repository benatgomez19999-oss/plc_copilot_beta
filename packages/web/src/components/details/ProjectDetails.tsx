import type { Project } from '@plccopilot/pir';
import { getFieldDiff } from '../../utils/field-diff.js';
import type { PirDiffEntry } from '../../utils/pir-diff.js';
import { DetailSection } from './DetailSection.js';
import { EditableField } from './EditableField.js';
import { FieldDiff } from './FieldDiff.js';
import { KeyValueGrid, type KeyValueRow } from './KeyValueGrid.js';

export interface ProjectDetailsProps {
  project: Project;
  /** Visual-edit hook — patches the draft JSON, never the applied project. */
  onPatch: (path: string, value: string) => void;
  /** Pending applied-vs-draft diffs. Filtered per node by exact path. */
  diffs?: PirDiffEntry[];
  /**
   * Optional jump-to-editor handler. When supplied, each row in the
   * `Pending changes` section becomes a button that scrolls Monaco to
   * the matching JSON line on click. Reuses the App's existing focus
   * pulse — same callback that powers the node-level Find button.
   */
  onFindInEditor?: (path: string) => void;
}

/**
 * Top-level project summary. Surfaces vendor-extension fields (`target`,
 * `tags`, `naming`) defensively — they are not part of the core PIR schema
 * but appear on hand-rolled / migrated PIRs and are worth showing when present.
 */
export function ProjectDetails({
  project,
  onPatch,
  diffs,
  onFindInEditor,
}: ProjectDetailsProps): JSX.Element {
  const rec = project as unknown as Record<string, unknown>;
  const target =
    rec.target && typeof rec.target === 'object' && !Array.isArray(rec.target)
      ? (rec.target as Record<string, unknown>)
      : null;
  const tags = Array.isArray(rec.tags)
    ? (rec.tags as unknown[]).filter(
        (t): t is string => typeof t === 'string',
      )
    : null;
  const naming =
    rec.naming && typeof rec.naming === 'object' && !Array.isArray(rec.naming)
      ? (rec.naming as Record<string, unknown>)
      : null;

  const baseRows: KeyValueRow[] = [
    { key: 'id', value: <code>{project.id}</code> },
    { key: 'name', value: project.name || '—' },
    { key: 'pir_version', value: <code>{project.pir_version}</code> },
    { key: 'machines', value: project.machines.length },
  ];
  if (project.description) {
    baseRows.push({ key: 'description', value: project.description });
  }

  const targetRows: KeyValueRow[] = [];
  if (target) {
    if (typeof target.vendor === 'string') {
      targetRows.push({ key: 'vendor', value: <code>{target.vendor}</code> });
    }
    if (typeof target.family === 'string') {
      targetRows.push({ key: 'family', value: <code>{target.family}</code> });
    }
    if (typeof target.tia_version === 'string') {
      targetRows.push({
        key: 'tia_version',
        value: <code>{target.tia_version}</code>,
      });
    }
  }

  const namingRows: KeyValueRow[] = [];
  if (naming) {
    if (typeof naming.id === 'string') {
      namingRows.push({ key: 'id', value: <code>{naming.id}</code> });
    }
    if (typeof naming.equipment_symbol_pattern === 'string') {
      namingRows.push({
        key: 'equipment_symbol_pattern',
        value: <code>{naming.equipment_symbol_pattern}</code>,
      });
    }
    if (typeof naming.io_symbol_pattern === 'string') {
      namingRows.push({
        key: 'io_symbol_pattern',
        value: <code>{naming.io_symbol_pattern}</code>,
      });
    }
  }

  return (
    <>
      <DetailSection title="Project">
        <KeyValueGrid rows={baseRows} />
      </DetailSection>

      {targetRows.length > 0 ? (
        <DetailSection title="Target">
          <KeyValueGrid rows={targetRows} />
        </DetailSection>
      ) : null}

      {namingRows.length > 0 ? (
        <DetailSection title="Naming profile">
          <KeyValueGrid rows={namingRows} />
        </DetailSection>
      ) : null}

      {tags && tags.length > 0 ? (
        <DetailSection title="Tags" count={tags.length}>
          <ul className="muted-list">
            {tags.map((t, i) => (
              <li key={`${t}-${i}`}>
                <code>{t}</code>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection title="Edit (draft only)">
        <EditableField
          label="name"
          value={project.name}
          jsonPath="$.name"
          allowEmpty={false}
          placeholder="Human-readable project name"
          onPatch={onPatch}
        />
      </DetailSection>

      <PendingChanges diffs={diffs} onFindInEditor={onFindInEditor} />
    </>
  );
}

function PendingChanges({
  diffs,
  onFindInEditor,
}: {
  diffs?: PirDiffEntry[];
  onFindInEditor?: (path: string) => void;
}): JSX.Element | null {
  // Field paths the project card surfaces as draft diffs. Editable fields
  // come first; the optional `description` is informational-only on
  // Project (no inline editor for it yet) but a Monaco edit landing
  // there should still surface in the diff section.
  const namePath = '$.name';
  const descPath = '$.description';
  const nameDiff = getFieldDiff(diffs, namePath);
  const descDiff = getFieldDiff(diffs, descPath);
  const hasAny = nameDiff.changed || descDiff.changed;
  if (!hasAny) return null;
  return (
    <DetailSection title="Pending changes">
      <FieldDiff
        label="name"
        path={namePath}
        diff={nameDiff}
        onFindInEditor={onFindInEditor}
      />
      <FieldDiff
        label="description"
        path={descPath}
        diff={descDiff}
        onFindInEditor={onFindInEditor}
      />
    </DetailSection>
  );
}

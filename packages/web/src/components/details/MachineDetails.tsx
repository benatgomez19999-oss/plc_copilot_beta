import type { Alarm, Project } from '@plccopilot/pir';
import { getFieldDiff } from '../../utils/field-diff.js';
import type { PirDiffEntry } from '../../utils/pir-diff.js';
import {
  getMachineByIndex,
  resolveMachineSummary,
} from '../../utils/pir-resolvers.js';
import { DetailSection } from './DetailSection.js';
import { EditableField } from './EditableField.js';
import { FieldDiff } from './FieldDiff.js';
import { KeyValueGrid, type KeyValueRow } from './KeyValueGrid.js';

export interface MachineDetailsProps {
  project: Project;
  machineIndex: number;
  /** Visual-edit hook — patches the draft JSON only. */
  onPatch: (path: string, value: string) => void;
  /** Pending applied-vs-draft diffs. */
  diffs?: PirDiffEntry[];
  /** Jump-to-editor handler for clickable Pending changes rows. */
  onFindInEditor?: (path: string) => void;
}

export function MachineDetails({
  project,
  machineIndex,
  onPatch,
  diffs,
  onFindInEditor,
}: MachineDetailsProps): JSX.Element {
  const machine = getMachineByIndex(project, machineIndex);
  const summary = resolveMachineSummary(project, machineIndex);
  if (!machine || !summary) {
    return <p className="muted">Machine not found at this index.</p>;
  }

  const rec = machine as unknown as Record<string, unknown>;
  const safetyStandard =
    typeof rec.safety_standard === 'string' ? rec.safety_standard : null;

  const baseRows: KeyValueRow[] = [
    { key: 'id', value: <code>{machine.id}</code> },
    { key: 'name', value: machine.name || '—' },
    { key: 'modes', value: summary.modes },
    { key: 'stations', value: summary.stations },
    { key: 'equipment', value: summary.equipment },
    { key: 'io', value: summary.io },
    { key: 'alarms', value: summary.alarms },
    { key: 'interlocks', value: summary.interlocks },
    { key: 'parameters', value: summary.parameters },
    { key: 'recipes', value: summary.recipes },
    { key: 'safety_groups', value: summary.safetyGroups },
  ];
  if (safetyStandard) {
    baseRows.push({ key: 'safety_standard', value: safetyStandard });
  }
  if (machine.description) {
    baseRows.push({ key: 'description', value: machine.description });
  }

  // Sort the equipment-type histogram by count desc so the dominant types
  // surface first; ties break alphabetically for stable display.
  const typeRows = Object.entries(summary.equipmentTypeCount).sort(
    ([a, an], [b, bn]) => bn - an || a.localeCompare(b),
  );

  const sevCounts = countAlarmsBySeverity(machine.alarms);

  return (
    <>
      <DetailSection title="Machine">
        <KeyValueGrid rows={baseRows} />
      </DetailSection>

      <DetailSection title="IO directions">
        <KeyValueGrid
          rows={[
            { key: 'inputs', value: summary.inputs },
            { key: 'outputs', value: summary.outputs },
          ]}
        />
      </DetailSection>

      {typeRows.length > 0 ? (
        <DetailSection title="Equipment types" count={typeRows.length}>
          <table className="mini-table">
            <thead>
              <tr>
                <th>type</th>
                <th>count</th>
              </tr>
            </thead>
            <tbody>
              {typeRows.map(([t, n]) => (
                <tr key={t}>
                  <td>
                    <code>{t}</code>
                  </td>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      ) : null}

      <DetailSection title="Alarms by severity">
        <KeyValueGrid
          rows={[
            {
              key: 'critical',
              value: <SeverityBadge sev="error" n={sevCounts.critical} />,
            },
            {
              key: 'warn',
              value: <SeverityBadge sev="warning" n={sevCounts.warn} />,
            },
            {
              key: 'info',
              value: <SeverityBadge sev="info" n={sevCounts.info} />,
            },
          ]}
        />
      </DetailSection>

      <DetailSection title="Edit (draft only)">
        <EditableField
          label="name"
          value={machine.name}
          jsonPath={`$.machines[${machineIndex}].name`}
          allowEmpty={false}
          onPatch={onPatch}
        />
        <EditableField
          label="description"
          value={machine.description}
          jsonPath={`$.machines[${machineIndex}].description`}
          allowEmpty
          placeholder="Optional description"
          onPatch={onPatch}
        />
      </DetailSection>

      <PendingChanges
        diffs={diffs}
        machineIndex={machineIndex}
        onFindInEditor={onFindInEditor}
      />
    </>
  );
}

function PendingChanges({
  diffs,
  machineIndex,
  onFindInEditor,
}: {
  diffs?: PirDiffEntry[];
  machineIndex: number;
  onFindInEditor?: (path: string) => void;
}): JSX.Element | null {
  const base = `$.machines[${machineIndex}]`;
  const namePath = `${base}.name`;
  const descPath = `${base}.description`;
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

function SeverityBadge({
  sev,
  n,
}: {
  sev: 'error' | 'warning' | 'info';
  n: number;
}): JSX.Element {
  return <span className={`badge sev-${sev}`}>{n}</span>;
}

interface SeverityCounts {
  critical: number;
  warn: number;
  info: number;
}

function countAlarmsBySeverity(alarms: Alarm[]): SeverityCounts {
  const out: SeverityCounts = { critical: 0, warn: 0, info: 0 };
  for (const a of alarms) {
    if (a.severity === 'critical') out.critical++;
    else if (a.severity === 'warn') out.warn++;
    else if (a.severity === 'info') out.info++;
  }
  return out;
}

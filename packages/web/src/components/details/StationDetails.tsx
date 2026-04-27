import type { Alarm, Project } from '@plccopilot/pir';
import { getFieldDiff } from '../../utils/field-diff.js';
import type { PirDiffEntry } from '../../utils/pir-diff.js';
import {
  getStationByPath,
  resolveStationRelations,
} from '../../utils/pir-resolvers.js';
import { DetailSection } from './DetailSection.js';
import { EditableField } from './EditableField.js';
import { FieldDiff } from './FieldDiff.js';
import { KeyValueGrid, type KeyValueRow } from './KeyValueGrid.js';

export interface StationDetailsProps {
  project: Project;
  machineIndex: number;
  stationIndex: number;
  /** Visual-edit hook — patches the draft JSON only. */
  onPatch: (path: string, value: string) => void;
  /** Pending applied-vs-draft diffs. */
  diffs?: PirDiffEntry[];
  /** Jump-to-editor handler for clickable Pending changes rows. */
  onFindInEditor?: (path: string) => void;
}

export function StationDetails({
  project,
  machineIndex,
  stationIndex,
  onPatch,
  diffs,
  onFindInEditor,
}: StationDetailsProps): JSX.Element {
  const station = getStationByPath(project, machineIndex, stationIndex);
  const rel = resolveStationRelations(project, machineIndex, stationIndex);
  if (!station || !rel) {
    return <p className="muted">Station not found at this index.</p>;
  }

  const stRec = station as unknown as Record<string, unknown>;
  const allowedModes = Array.isArray(stRec.allowed_modes)
    ? (stRec.allowed_modes as unknown[]).filter(
        (m): m is string => typeof m === 'string',
      )
    : null;

  const baseRows: KeyValueRow[] = [
    { key: 'id', value: <code>{station.id}</code> },
    { key: 'name', value: station.name || '—' },
    { key: 'equipment', value: station.equipment.length },
  ];
  if (station.description) {
    baseRows.push({ key: 'description', value: station.description });
  }

  return (
    <>
      <DetailSection title="Station">
        <KeyValueGrid rows={baseRows} />
      </DetailSection>

      {allowedModes && allowedModes.length > 0 ? (
        <DetailSection title="Allowed modes" count={allowedModes.length}>
          <ul className="muted-list">
            {allowedModes.map((m, i) => (
              <li key={`${m}-${i}`}>
                <code>{m}</code>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {rel.sequence ? (
        <DetailSection title="Sequence">
          <KeyValueGrid
            rows={[
              { key: 'states', value: rel.sequence.states },
              { key: 'transitions', value: rel.sequence.transitions },
              {
                key: 'initial state',
                value: rel.sequence.initialState ? (
                  <code>{rel.sequence.initialState}</code>
                ) : (
                  <span className="muted">—</span>
                ),
              },
              {
                key: 'terminal states',
                value:
                  rel.sequence.terminalStates.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <CommaCodes items={rel.sequence.terminalStates} />
                  ),
              },
            ]}
          />
        </DetailSection>
      ) : null}

      {rel.equipment.length > 0 ? (
        <DetailSection title="Equipment" count={rel.equipment.length}>
          <table className="mini-table">
            <thead>
              <tr>
                <th>id</th>
                <th>type</th>
              </tr>
            </thead>
            <tbody>
              {rel.equipment.map((e) => (
                <tr key={e.id}>
                  <td>
                    <code>{e.id}</code>
                  </td>
                  <td>
                    <code>{e.type}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      ) : null}

      {rel.alarms.length > 0 ? (
        <DetailSection title="Related alarms" count={rel.alarms.length}>
          <AlarmList alarms={rel.alarms} />
        </DetailSection>
      ) : null}

      {rel.interlocks.length > 0 ? (
        <DetailSection
          title="Related interlocks"
          count={rel.interlocks.length}
        >
          <ul className="muted-list">
            {rel.interlocks.map((il) => (
              <li key={il.id}>
                <code>{il.id}</code>{' '}
                <span className="muted small">inhibits {il.inhibits}</span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      {rel.safetyGroups.length > 0 ? (
        <DetailSection
          title="Safety groups"
          count={rel.safetyGroups.length}
        >
          <ul className="muted-list">
            {rel.safetyGroups.map((sg) => (
              <li key={sg.id}>
                <code>{sg.id}</code>{' '}
                <span className="muted small">({sg.category})</span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection title="Edit (draft only)">
        <EditableField
          label="name"
          value={station.name}
          jsonPath={`$.machines[${machineIndex}].stations[${stationIndex}].name`}
          allowEmpty={false}
          onPatch={onPatch}
        />
        <EditableField
          label="description"
          value={station.description}
          jsonPath={`$.machines[${machineIndex}].stations[${stationIndex}].description`}
          allowEmpty
          placeholder="Optional description"
          onPatch={onPatch}
        />
      </DetailSection>

      <PendingChanges
        diffs={diffs}
        machineIndex={machineIndex}
        stationIndex={stationIndex}
        onFindInEditor={onFindInEditor}
      />
    </>
  );
}

function PendingChanges({
  diffs,
  machineIndex,
  stationIndex,
  onFindInEditor,
}: {
  diffs?: PirDiffEntry[];
  machineIndex: number;
  stationIndex: number;
  onFindInEditor?: (path: string) => void;
}): JSX.Element | null {
  const base = `$.machines[${machineIndex}].stations[${stationIndex}]`;
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

function CommaCodes({ items }: { items: string[] }): JSX.Element {
  return (
    <span>
      {items.map((t, i) => (
        <span key={`${t}-${i}`}>
          <code>{t}</code>
          {i < items.length - 1 ? ', ' : ''}
        </span>
      ))}
    </span>
  );
}

export function AlarmList({ alarms }: { alarms: Alarm[] }): JSX.Element {
  return (
    <ul className="muted-list">
      {alarms.map((a) => (
        <li key={a.id}>
          <span className={`badge sev-${alarmSevClass(a.severity)}`}>
            {a.severity}
          </span>{' '}
          <code>{a.id}</code>
        </li>
      ))}
    </ul>
  );
}

function alarmSevClass(s: Alarm['severity']): 'error' | 'warning' | 'info' {
  if (s === 'critical') return 'error';
  if (s === 'warn') return 'warning';
  return 'info';
}

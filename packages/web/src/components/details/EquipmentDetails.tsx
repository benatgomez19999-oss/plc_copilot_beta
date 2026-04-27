import type { Project } from '@plccopilot/pir';
import { getFieldDiff } from '../../utils/field-diff.js';
import type { PirDiffEntry } from '../../utils/pir-diff.js';
import {
  getEquipmentByPath,
  resolveEquipmentRelations,
  type ResolvedIoBinding,
} from '../../utils/pir-resolvers.js';
import { DetailSection } from './DetailSection.js';
import { EditableField } from './EditableField.js';
import { FieldDiff } from './FieldDiff.js';
import { KeyValueGrid, type KeyValueRow } from './KeyValueGrid.js';
import { AlarmList } from './StationDetails.js';

export interface EquipmentDetailsProps {
  project: Project;
  machineIndex: number;
  stationIndex: number;
  equipmentIndex: number;
  /** Visual-edit hook — patches the draft JSON only. */
  onPatch: (path: string, value: string) => void;
  /** Pending applied-vs-draft diffs. */
  diffs?: PirDiffEntry[];
  /** Jump-to-editor handler for clickable Pending changes rows. */
  onFindInEditor?: (path: string) => void;
}

export function EquipmentDetails({
  project,
  machineIndex,
  stationIndex,
  equipmentIndex,
  onPatch,
  diffs,
  onFindInEditor,
}: EquipmentDetailsProps): JSX.Element {
  const eq = getEquipmentByPath(
    project,
    machineIndex,
    stationIndex,
    equipmentIndex,
  );
  const rel = resolveEquipmentRelations(
    project,
    machineIndex,
    stationIndex,
    equipmentIndex,
  );
  if (!eq || !rel) {
    return <p className="muted">Equipment not found at this index.</p>;
  }

  const baseRows: KeyValueRow[] = [
    { key: 'id', value: <code>{eq.id}</code> },
    { key: 'display_name', value: eq.name || '—' },
    { key: 'type', value: <code>{eq.type}</code> },
  ];
  if (eq.code_symbol) {
    baseRows.push({
      key: 'code_symbol',
      value: <code>{eq.code_symbol}</code>,
    });
  }
  if (eq.description) {
    baseRows.push({ key: 'description', value: eq.description });
  }

  const timing = eq.timing ? Object.entries(eq.timing) : [];

  return (
    <>
      <DetailSection title="Equipment">
        <KeyValueGrid rows={baseRows} />
      </DetailSection>

      <DetailSection title="IO bindings" count={rel.bindings.length}>
        <IoBindingsTable bindings={rel.bindings} />
      </DetailSection>

      {timing.length > 0 ? (
        <DetailSection title="Timing" count={timing.length}>
          <table className="mini-table">
            <thead>
              <tr>
                <th>field</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {timing.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{String(v)}</td>
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

      {eq.provenance ? (
        <DetailSection title="Provenance">
          <KeyValueGrid
            rows={[
              { key: 'source', value: <code>{eq.provenance.source}</code> },
              {
                key: 'created_at',
                value: <code>{eq.provenance.created_at}</code>,
              },
              ...(eq.provenance.notes
                ? [{ key: 'notes', value: eq.provenance.notes }]
                : []),
            ]}
          />
        </DetailSection>
      ) : null}

      <DetailSection title="Edit (draft only)">
        <EditableField
          label="display_name"
          value={eq.name}
          jsonPath={`$.machines[${machineIndex}].stations[${stationIndex}].equipment[${equipmentIndex}].name`}
          allowEmpty={false}
          onPatch={onPatch}
        />
        <EditableField
          label="code_symbol"
          value={eq.code_symbol}
          jsonPath={`$.machines[${machineIndex}].stations[${stationIndex}].equipment[${equipmentIndex}].code_symbol`}
          allowEmpty
          placeholder="e.g. Cyl01 (must match identifier regex)"
          onPatch={onPatch}
        />
        <EditableField
          label="description"
          value={eq.description}
          jsonPath={`$.machines[${machineIndex}].stations[${stationIndex}].equipment[${equipmentIndex}].description`}
          allowEmpty
          placeholder="Optional description"
          onPatch={onPatch}
        />
      </DetailSection>

      <PendingChanges
        diffs={diffs}
        machineIndex={machineIndex}
        stationIndex={stationIndex}
        equipmentIndex={equipmentIndex}
        onFindInEditor={onFindInEditor}
      />
    </>
  );
}

function PendingChanges({
  diffs,
  machineIndex,
  stationIndex,
  equipmentIndex,
  onFindInEditor,
}: {
  diffs?: PirDiffEntry[];
  machineIndex: number;
  stationIndex: number;
  equipmentIndex: number;
  onFindInEditor?: (path: string) => void;
}): JSX.Element | null {
  const base = `$.machines[${machineIndex}].stations[${stationIndex}].equipment[${equipmentIndex}]`;
  const namePath = `${base}.name`;
  const codePath = `${base}.code_symbol`;
  const descPath = `${base}.description`;
  const nameDiff = getFieldDiff(diffs, namePath);
  const codeDiff = getFieldDiff(diffs, codePath);
  const descDiff = getFieldDiff(diffs, descPath);
  const hasAny = nameDiff.changed || codeDiff.changed || descDiff.changed;
  if (!hasAny) return null;
  return (
    <DetailSection title="Pending changes">
      <FieldDiff
        label="display_name"
        path={namePath}
        diff={nameDiff}
        onFindInEditor={onFindInEditor}
      />
      <FieldDiff
        label="code_symbol"
        path={codePath}
        diff={codeDiff}
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

function IoBindingsTable({
  bindings,
}: {
  bindings: ResolvedIoBinding[];
}): JSX.Element {
  if (bindings.length === 0) {
    return <p className="muted small">No IO bindings declared.</p>;
  }
  return (
    <table className="mini-table io-bindings">
      <thead>
        <tr>
          <th>Role</th>
          <th>IO id</th>
          <th>Status</th>
          <th>Address</th>
          <th>Type</th>
          <th>Direction</th>
          <th>Display name</th>
        </tr>
      </thead>
      <tbody>
        {bindings.map((b) => (
          <tr key={b.role}>
            <td>
              <code>{b.role}</code>
            </td>
            <td>
              <code>{b.ioId}</code>
            </td>
            <td>
              {b.found ? (
                <span className="badge-ok">found</span>
              ) : (
                <span className="badge-missing">missing</span>
              )}
            </td>
            <td>
              {b.signal ? (
                <code>{b.signal.addressRaw}</code>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              {b.signal ? (
                <code>{b.signal.dtype}</code>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              {b.signal ? (
                <code>{b.signal.direction}</code>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              {b.signal ? (
                b.signal.displayName
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

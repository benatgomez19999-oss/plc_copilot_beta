// Sprint 88M — shared parameter / setpoint-binding extractor for
// structured XML sources (EPLAN XML, TcECAD XML). Mirror of CSV
// `row_kind=parameter` / `row_kind=setpoint_binding` rows from
// Sprint 88L; same hard rules:
//
//   - structured-only: every parameter / binding lives in a
//     dedicated XML element. Nothing is inferred from
//     `<Comment>`, `<Description>`, free text, or numeric values
//     embedded inside attributes that name something else.
//   - numeric-only data types (`int` / `dint` / `real`); `bool`
//     parameters cannot back a numeric output role and are
//     refused at extraction (mirrors PIR R-EQ-05 sub-rule B5).
//   - only `speed_setpoint_out` is a supported binding role in v0.
//   - duplicate parameter ids are warned about; first wins.
//   - missing / unparseable required fields fire deterministic
//     per-element diagnostics; the offending element is dropped.
//
// The helper is pure / total: it accepts an already-parsed XML
// tree (root `XmlElement`) and a small context bag, walks the
// tree once, and returns an `ElectricalParameterDraft`. No I/O,
// no DOM, no browser deps — works in Node + bundlers identically.

import { confidenceOf } from '../confidence.js';
import { createElectricalDiagnostic } from '../diagnostics.js';
import {
  getAttribute,
  getChildText,
  walkElements,
  type XmlElement,
} from '../sources/xml-utils.js';
import type {
  ElectricalDiagnostic,
  ElectricalParameterDraft,
  ElectricalSourceKind,
  PirParameterCandidate,
  SourceRef,
} from '../types.js';

const SUPPORTED_SETPOINT_ROLES: ReadonlySet<string> = new Set([
  'speed_setpoint_out',
]);

/**
 * Tag names recognised as "this XML element declares a numeric
 * machine Parameter". Lowercased; the helper compares against
 * `el.tagLower`. The shape supports two equivalent declarations:
 *
 *   <Parameter id="..." dataType="..." default="..." unit="..." />
 *   <parameter id="..." data_type="..." default="..." unit="..." />
 *
 * Either attribute names (camelCase) or snake-cased fall-backs
 * are accepted on a per-field basis.
 */
const PARAMETER_TAGS: ReadonlySet<string> = new Set(['parameter']);

/**
 * Tag names recognised as "this XML element declares an
 * (equipment, role) → parameter setpoint binding". Lowercased.
 *
 *   <SetpointBinding equipmentId="M01" role="speed_setpoint_out"
 *                    parameterId="p_m01_speed" />
 *   <setpoint_binding equipment_id="M01" role="speed_setpoint_out"
 *                     parameter_id="p_m01_speed" />
 */
const SETPOINT_BINDING_TAGS: ReadonlySet<string> = new Set([
  'setpointbinding',
  'setpoint_binding',
]);

export interface StructuredDraftContext {
  /** Carried into emitted diagnostics + parameter SourceRefs. */
  sourceId: string;
  /**
   * `'eplan'` or `'twincat_ecad'` (or any future structured XML
   * source kind). Used solely to populate `SourceRef.kind` and the
   * diagnostic message prefix.
   */
  kind: ElectricalSourceKind;
  /** Optional file path the XML was loaded from. */
  fileName?: string;
}

/**
 * Walk the XML tree once and extract every structured parameter +
 * setpoint-binding declaration. Pure / total — never throws.
 */
export function extractStructuredParameterDraft(
  root: XmlElement,
  ctx: StructuredDraftContext,
): ElectricalParameterDraft {
  const draft: ElectricalParameterDraft = {
    parameters: [],
    setpointBindings: {},
    diagnostics: [],
  };
  const seenIds = new Set<string>();

  for (const el of walkElements(root)) {
    if (PARAMETER_TAGS.has(el.tagLower)) {
      processParameter(el, ctx, draft, seenIds);
      continue;
    }
    if (SETPOINT_BINDING_TAGS.has(el.tagLower)) {
      processBinding(el, ctx, draft);
      continue;
    }
  }

  return draft;
}

/**
 * True if the draft carries no parameters, no bindings, and no
 * diagnostics. Ingestors call this to decide whether to attach
 * `metadata.parameterDraft` at all — empty drafts on legacy XML
 * leave metadata untouched.
 */
export function isStructuredParameterDraftEmpty(
  draft: ElectricalParameterDraft,
): boolean {
  return (
    draft.parameters.length === 0 &&
    Object.keys(draft.setpointBindings).length === 0 &&
    draft.diagnostics.length === 0
  );
}

// ---------------------------------------------------------------------------
// Internal: per-element processors
// ---------------------------------------------------------------------------

function processParameter(
  el: XmlElement,
  ctx: StructuredDraftContext,
  draft: ElectricalParameterDraft,
  seenIds: Set<string>,
): void {
  const id = readField(el, 'id', 'parameterId', 'parameter_id', 'name');
  const ref = makeRef(el, ctx, id ?? undefined);

  if (!id) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_PARAMETER_METADATA_INCOMPLETE',
        message: `${prefix(ctx)} parameter element at line ${el.line} has no id / parameter_id / name attribute.`,
        sourceRef: ref,
        hint: 'set the id (or parameter_id) attribute to a stable parameter id (e.g. p_m01_speed).',
      }),
    );
    return;
  }
  if (seenIds.has(id)) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_PARAMETER_DUPLICATE_ID',
        message: `${prefix(ctx)} parameter element at line ${el.line} duplicates id ${JSON.stringify(id)}; second occurrence skipped.`,
        sourceRef: ref,
      }),
    );
    return;
  }

  const dataTypeRaw = readField(
    el,
    'dataType',
    'data_type',
    'datatype',
    'dtype',
  );
  const dataType = parseDataType(dataTypeRaw);
  if (!dataType) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_PARAMETER_METADATA_NOT_NUMERIC',
        message: `${prefix(ctx)} parameter ${JSON.stringify(id)} at line ${el.line} declares dataType ${JSON.stringify(dataTypeRaw ?? '')}; expected one of int / dint / real (numeric only — bool parameters cannot back a numeric output role per PIR R-EQ-05).`,
        sourceRef: ref,
        hint: 'set dataType to int, dint, or real.',
      }),
    );
    return;
  }

  const defaultRaw = readField(
    el,
    'default',
    'defaultValue',
    'default_value',
  );
  const defaultValue = parseFiniteNumber(defaultRaw);
  if (defaultValue === null) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_PARAMETER_DEFAULT_INVALID',
        message: `${prefix(ctx)} parameter ${JSON.stringify(id)} at line ${el.line} is missing or has an unparseable default (got ${JSON.stringify(defaultRaw ?? '')}).`,
        sourceRef: ref,
        hint: 'set default to a finite number; unit conversion is the operator\'s responsibility — Sprint 88M does no scaling.',
      }),
    );
    return;
  }

  const unit = readField(el, 'unit', 'units', 'eu');
  const label =
    readField(el, 'label') ??
    readField(el, 'description') ??
    null;

  const param: PirParameterCandidate = {
    id,
    dataType,
    defaultValue,
    sourceRefs: [ref],
    confidence: confidenceOf(0.9, `${ctx.kind} structured parameter element`),
  };
  if (label) param.label = label;
  if (unit) param.unit = unit;
  draft.parameters.push(param);
  seenIds.add(id);

  draft.diagnostics.push(
    createElectricalDiagnostic({
      code: 'STRUCTURED_PARAMETER_EXTRACTED',
      message: `parameter ${JSON.stringify(id)} (${dataType}, default=${defaultValue}${unit ? `, unit=${unit}` : ''}) extracted from ${ctx.kind} at line ${el.line}.`,
      sourceRef: ref,
    }),
  );
}

function processBinding(
  el: XmlElement,
  ctx: StructuredDraftContext,
  draft: ElectricalParameterDraft,
): void {
  const equipmentId = readField(
    el,
    'equipmentId',
    'equipment_id',
    'equipmentid',
    'tag',
  );
  const role = readField(el, 'role', 'io_role');
  const parameterId = readField(
    el,
    'parameterId',
    'parameter_id',
    'parameterid',
    'param_id',
  );
  const ref = makeRef(el, ctx, equipmentId ?? undefined);

  if (!equipmentId) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_SETPOINT_BINDING_TARGET_MISSING',
        message: `${prefix(ctx)} setpoint_binding element at line ${el.line} has no equipmentId / tag attribute.`,
        sourceRef: ref,
      }),
    );
    return;
  }
  if (!role || !SUPPORTED_SETPOINT_ROLES.has(role)) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_SETPOINT_BINDING_ROLE_UNSUPPORTED',
        message: `${prefix(ctx)} setpoint_binding element at line ${el.line} declares role ${JSON.stringify(role ?? '')}; Sprint 88L/88M only supports ${[
          ...SUPPORTED_SETPOINT_ROLES,
        ]
          .map((r) => JSON.stringify(r))
          .join(', ')}.`,
        sourceRef: ref,
      }),
    );
    return;
  }
  if (!parameterId) {
    draft.diagnostics.push(
      createElectricalDiagnostic({
        code: 'STRUCTURED_SETPOINT_BINDING_PARAMETER_MISSING',
        message: `${prefix(ctx)} setpoint_binding element at line ${el.line} (equipment ${JSON.stringify(equipmentId)}, role ${JSON.stringify(role)}) has no parameterId.`,
        sourceRef: ref,
      }),
    );
    return;
  }

  const map = draft.setpointBindings[equipmentId] ?? {};
  map[role] = parameterId;
  draft.setpointBindings[equipmentId] = map;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read an XML field by name, supporting both attribute style
 * (`<Parameter id="...">`) and child-element-text style
 * (`<Parameter><id>...</id></Parameter>`). Attribute hits win;
 * child-element fall-back keeps the helper compatible with the
 * TcECAD shape that uses `<Name>...</Name>` children.
 */
function readField(el: XmlElement, ...names: ReadonlyArray<string>): string | null {
  const attr = getAttribute(el, ...names);
  if (attr !== null) {
    const trimmed = attr.trim();
    if (trimmed.length > 0) return trimmed;
  }
  for (const n of names) {
    const child = getChildText(el, n.toLowerCase());
    if (child !== null) {
      const trimmed = child.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function parseDataType(raw: string | null): 'int' | 'dint' | 'real' | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'int') return 'int';
  if (v === 'dint') return 'dint';
  if (v === 'real') return 'real';
  return null;
}

function parseFiniteNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

function makeRef(
  el: XmlElement,
  ctx: StructuredDraftContext,
  rawId: string | undefined,
): SourceRef {
  const ref: SourceRef = {
    sourceId: ctx.sourceId,
    kind: ctx.kind,
    line: el.line,
    symbol: el.locator,
  };
  if (ctx.fileName) ref.path = ctx.fileName;
  if (rawId) ref.rawId = rawId;
  return ref;
}

function prefix(ctx: StructuredDraftContext): string {
  return ctx.kind === 'twincat_ecad'
    ? 'TcECAD XML'
    : ctx.kind.toUpperCase();
}

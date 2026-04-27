import type { ResolvedSymbol } from '../symbols/types.js';

// ---------- Reference IR (vendor-neutral target) ----------

/**
 * A pointer to a storage location, used by assignment targets, FB instance
 * calls, and as an expression leaf. The renderer maps each variant to the
 * backend-specific lexical convention (`#name` / `"name"` / `GVL_X.f` / ...).
 */
export type RefIR =
  | { kind: 'local'; name: string }
  | { kind: 'global'; name: string }
  | { kind: 'dbField'; dbName: string; fieldName: string }
  | { kind: 'fbInstance'; name: string };

// ---------- Expression IR ----------

export type BinaryOp =
  | 'AND'
  | 'OR'
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>=';

/**
 * Edge-trigger output reference. Carries `edgeKind` for tooling / diagnostics
 * (the renderer always emits `.Q`). Replaces the old `Raw('#R_TRIG_x.Q')`
 * pattern that the Codesys backend had to strip with regex.
 */
export interface EdgeRefIR {
  kind: 'EdgeRef';
  instanceName: string;
  edgeKind: 'rising' | 'falling' | 'edge';
}

/**
 * `instance.fieldName` access on an FB instance — used for `TON.Q`,
 * `timer_expired(x)`, future `R_TRIG.CLK` assignments, etc.
 *
 * Renders by composing `renderRef(instance, backend)` + `.fieldName`, so the
 * `#` (Siemens) / bare (Codesys) decision comes from the same RefIR layer
 * that handles every other reference. This eliminates the last `Raw` text
 * carrier on the station-FB hot path.
 */
export interface InstanceFieldIR {
  kind: 'InstanceField';
  instance: RefIR;
  fieldName: string;
}

export type ExprIR =
  | { kind: 'Raw'; text: string }
  | { kind: 'BoolLit'; value: boolean }
  | { kind: 'NumLit'; value: number; numType: 'Int' | 'DInt' | 'Real' }
  | { kind: 'StringLit'; value: string }
  | { kind: 'SymbolRef'; symbol: ResolvedSymbol }
  | { kind: 'Ref'; ref: RefIR }
  | EdgeRefIR
  | InstanceFieldIR
  | { kind: 'Paren'; inner: ExprIR }
  | { kind: 'Unary'; op: 'NOT'; operand: ExprIR }
  | { kind: 'Binary'; op: BinaryOp; left: ExprIR; right: ExprIR }
  | { kind: 'Call'; fn: string; args: ExprIR[] };

// ---------- Statement IR ----------

export interface FbCallParam {
  name: string;
  value: ExprIR;
}

export type StmtIR =
  | { kind: 'Assign'; target: RefIR; expr: ExprIR; comment?: string }
  | { kind: 'Comment'; text: string }
  | { kind: 'RawStmt'; text: string }
  | {
      kind: 'If';
      cond: ExprIR;
      then: StmtIR[];
      elseIfs?: { cond: ExprIR; body: StmtIR[] }[];
      else?: StmtIR[];
    }
  | { kind: 'Case'; selector: ExprIR; arms: CaseArmIR[]; else?: StmtIR[] }
  | { kind: 'TonCall'; instance: RefIR; inExpr: ExprIR; ptMs: number }
  | {
      kind: 'FbCall';
      instance: RefIR;
      params: FbCallParam[];
      comment?: string;
    };

export interface CaseArmIR {
  value: number;
  label?: string;
  body: StmtIR[];
}

// ---------- Declaration IR ----------

export type VarSection = 'VAR_INPUT' | 'VAR_OUTPUT' | 'VAR';

export interface VarDeclIR {
  name: string;
  type: string;
  init?: string;
  /** Inline trailing comment (no `//` or `(* *)` markers — renderer wraps). */
  comment?: string;
  /** Section header rendered above this decl (no markers). */
  preComment?: string;
}

export interface VarSectionIR {
  section: VarSection;
  decls: VarDeclIR[];
}

// ---------- Top-level IR ----------

export interface FunctionBlockIR {
  name: string;
  /** PIR station id when this FB was produced from `lowerStation`. */
  stationId?: string;
  /** Header comment lines WITHOUT marker prefix — renderer wraps with // or (* *). */
  headerComments: string[];
  attributes: string[];
  version: string;
  varSections: VarSectionIR[];
  body: StmtIR[];
}

export interface ProgramIR {
  blocks: FunctionBlockIR[];
}

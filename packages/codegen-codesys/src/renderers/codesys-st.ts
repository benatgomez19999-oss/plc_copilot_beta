import type {
  ExprIR,
  FunctionBlockIR,
  StmtIR,
  VarSectionIR,
} from '@plccopilot/codegen-core';
import {
  renderRef as renderRefCore,
  renderSymbol as renderSymbolCore,
} from '@plccopilot/codegen-core';
import { CODESYS_NAMESPACES } from '../naming.js';

const UNIT = '    ';

function pad(level: number, line: string): string {
  return line === '' ? '' : UNIT.repeat(level) + line;
}

// Local helpers — every render call carries the Codesys namespace map so the
// vendor-neutral `renderRef` / `renderSymbol` from core stay map-agnostic.
function renderRef(r: Parameters<typeof renderRefCore>[0]): string {
  return renderRefCore(r, 'codesys', CODESYS_NAMESPACES);
}
function renderSymbol(s: Parameters<typeof renderSymbolCore>[0]): string {
  return renderSymbolCore(s, 'codesys', CODESYS_NAMESPACES);
}

/**
 * RawIR fallback translation. After this sprint, well-formed station FBs
 * carry no Siemens lexical conventions in any structured node — they live
 * only in `Raw` text emitted by `timer_expired(...)` calls and any future
 * direct `ir.raw(...)` usage. This regex is the safety net.
 *
 *   "DB_Alarms".X  → GVL_Alarms.X
 *   "name"         → name
 *   #name          → name
 */
export function siemensToCodesysText(s: string): string {
  let r = s;
  for (const [db, alias] of Object.entries(CODESYS_NAMESPACES)) {
    r = r.replace(new RegExp(`"${db}"\\.(\\w+)`, 'g'), `${alias}.$1`);
  }
  r = r.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1');
  r = r.replace(/#([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
  return r;
}

// ---------- Expression rendering ----------

export function renderExprCodesys(e: ExprIR): string {
  switch (e.kind) {
    case 'Raw':
      return siemensToCodesysText(e.text);
    case 'BoolLit':
      return e.value ? 'TRUE' : 'FALSE';
    case 'NumLit':
      if (e.numType === 'Real') {
        const s = String(e.value);
        return /[.eE]/.test(s) ? s : `${s}.0`;
      }
      return String(e.value);
    case 'StringLit':
      return `'${e.value.replace(/'/g, "''")}'`;
    case 'SymbolRef':
      return renderSymbol(e.symbol);
    case 'Ref':
      return renderRef(e.ref);
    case 'EdgeRef':
      return `${e.instanceName}.Q`;
    case 'InstanceField':
      return `${renderRef(e.instance)}.${e.fieldName}`;
    case 'Paren':
      return `(${renderExprCodesys(e.inner)})`;
    case 'Unary':
      return `NOT ${renderExprCodesys(e.operand)}`;
    case 'Binary':
      return `${renderExprCodesys(e.left)} ${e.op} ${renderExprCodesys(e.right)}`;
    case 'Call':
      return `${e.fn}(${e.args.map(renderExprCodesys).join(', ')})`;
  }
}

// ---------- Statement rendering ----------

export function renderStmtCodesys(stmt: StmtIR, level: number): string[] {
  switch (stmt.kind) {
    case 'Assign': {
      const c = stmt.comment ? ` (* ${stmt.comment} *)` : '';
      return [
        pad(
          level,
          `${renderRef(stmt.target)} := ${renderExprCodesys(stmt.expr)};${c}`,
        ),
      ];
    }
    case 'Comment':
      return [pad(level, `(* ${stmt.text} *)`)];
    case 'RawStmt':
      return [
        stmt.text === '' ? '' : pad(level, siemensToCodesysText(stmt.text)),
      ];
    case 'If':
      return renderIfCodesys(stmt, level);
    case 'Case':
      return renderCaseCodesys(stmt, level);
    case 'TonCall':
      return [
        pad(
          level,
          `${renderRef(stmt.instance)}(IN := ${renderExprCodesys(stmt.inExpr)}, PT := T#${stmt.ptMs}MS);`,
        ),
      ];
    case 'FbCall': {
      const params = stmt.params
        .map((p) => `${p.name} := ${renderExprCodesys(p.value)}`)
        .join(', ');
      const c = stmt.comment ? ` (* ${stmt.comment} *)` : '';
      return [
        pad(level, `${renderRef(stmt.instance)}(${params});${c}`),
      ];
    }
  }
}

function renderIfCodesys(
  stmt: Extract<StmtIR, { kind: 'If' }>,
  level: number,
): string[] {
  const out: string[] = [];
  out.push(pad(level, `IF ${renderExprCodesys(stmt.cond)} THEN`));
  for (const s of stmt.then) out.push(...renderStmtCodesys(s, level + 1));
  if (stmt.elseIfs) {
    for (const ei of stmt.elseIfs) {
      out.push(pad(level, `ELSIF ${renderExprCodesys(ei.cond)} THEN`));
      for (const s of ei.body) out.push(...renderStmtCodesys(s, level + 1));
    }
  }
  if (stmt.else) {
    out.push(pad(level, `ELSE`));
    for (const s of stmt.else) out.push(...renderStmtCodesys(s, level + 1));
  }
  out.push(pad(level, `END_IF;`));
  return out;
}

function renderCaseCodesys(
  stmt: Extract<StmtIR, { kind: 'Case' }>,
  level: number,
): string[] {
  const out: string[] = [];
  out.push(pad(level, `CASE ${renderExprCodesys(stmt.selector)} OF`));
  for (const arm of stmt.arms) {
    const label = arm.label ? `  (* ${arm.label} *)` : '';
    out.push(pad(level + 1, `${arm.value}:${label}`));
    if (arm.body.length === 0) {
      out.push(pad(level + 2, ';'));
    } else {
      for (const s of arm.body) out.push(...renderStmtCodesys(s, level + 2));
    }
  }
  out.push(pad(level, `ELSE`));
  if (stmt.else && stmt.else.length > 0) {
    for (const s of stmt.else) out.push(...renderStmtCodesys(s, level + 1));
  } else {
    out.push(pad(level + 1, ';'));
  }
  out.push(pad(level, `END_CASE;`));
  return out;
}

// ---------- VAR sections ----------

export function renderVarSectionCodesys(
  section: VarSectionIR,
  level: number,
): string[] {
  const out: string[] = [pad(level, section.section)];
  for (const d of section.decls) {
    if (d.preComment) out.push(pad(level + 1, `(* ${d.preComment} *)`));
    const init = d.init !== undefined ? ` := ${d.init}` : '';
    const comment = d.comment ? ` (* ${d.comment} *)` : '';
    out.push(pad(level + 1, `${d.name} : ${d.type}${init};${comment}`));
  }
  out.push(pad(level, 'END_VAR'));
  return out;
}

// ---------- FUNCTION_BLOCK ----------

export function renderFunctionBlockCodesys(fb: FunctionBlockIR): string {
  const lines: string[] = [];
  for (const hc of fb.headerComments) lines.push(`(* ${hc} *)`);
  lines.push(`FUNCTION_BLOCK ${fb.name}`);
  lines.push('');
  for (const sec of fb.varSections) {
    lines.push(...renderVarSectionCodesys(sec, 0));
    lines.push('');
  }
  // IEC 61131-3 has no BEGIN keyword — body sits at column 0.
  for (const s of fb.body) lines.push(...renderStmtCodesys(s, 0));
  lines.push('END_FUNCTION_BLOCK');
  lines.push('');
  return lines.join('\n');
}

import type {
  ExprIR,
  FunctionBlockIR,
  StmtIR,
  VarDeclIR,
  VarSectionIR,
} from '@plccopilot/codegen-core';
import {
  renderRef as renderRefCore,
  renderSymbol as renderSymbolCore,
} from '@plccopilot/codegen-core';
import { ROCKWELL_NAMESPACES } from '../naming.js';

// Local helpers that pin the Rockwell namespace map onto every core call.
function renderRef(r: Parameters<typeof renderRefCore>[0]): string {
  return renderRefCore(r, 'rockwell', ROCKWELL_NAMESPACES);
}
function renderSymbol(s: Parameters<typeof renderSymbolCore>[0]): string {
  return renderSymbolCore(s, 'rockwell', ROCKWELL_NAMESPACES);
}

/**
 * Rockwell / Studio 5000 ST POC renderer. Emits plausible Logix-flavoured
 * Structured Text from the same vendor-neutral FunctionBlockIR that drives
 * Siemens and Codesys, with two backend-specific transformations:
 *
 *   1. Edge triggers (R_TRIG / F_TRIG) lower to the one-shot bit pattern:
 *
 *        R_TRIG_x := source AND NOT R_TRIG_x_MEM;
 *        R_TRIG_x_MEM := source;
 *
 *      Both bits are declared as BOOL — no IEC FB instance. The expression
 *      `EdgeRef('R_TRIG_x', ...)` renders as just `R_TRIG_x` (the one-shot).
 *
 *   2. Pseudo-IEC TON. Studio 5000 has its own `TIMER`/`TON` control-bit AOI
 *      with `.DN` semantics, not IEC `.Q`. The POC keeps the IEC form so the
 *      ProgramIR contract stays vendor-neutral; a `ROCKWELL_TIMER_PSEUDO_IEC`
 *      warning surfaces the divergence at the manifest layer. A future L5X
 *      backend will rewrite TonCall → Logix TIMER instructions.
 *
 * What the renderer DELIBERATELY does NOT do:
 *   - emit a `.L5X` archive
 *   - declare controller / program tags
 *   - generate AOI / routine import metadata
 *
 * Studio 5000 import requires manual mapping. This is a POC for IR validation.
 */

const PAD = '    ';

function pad(level: number, line: string): string {
  return line === '' ? '' : PAD.repeat(level) + line;
}

const PIR_TO_LOGIX: Record<string, string> = {
  Bool: 'BOOL',
  Int: 'INT',
  DInt: 'DINT',
  Real: 'REAL',
};

/**
 * Map an IR data type name to its Rockwell ST spelling. Edge-trigger types
 * are caught by `renderVarSectionRockwell` before this function is reached.
 *   Bool/Int/DInt/Real → uppercase IEC.
 *   TON                → kept as `TON` (pseudo-IEC; flagged by diagnostic).
 *   anything else      → upper-cased pass-through.
 */
function rockwellType(t: string): string {
  return PIR_TO_LOGIX[t] ?? t.toUpperCase();
}

const EDGE_INSTANCE_RE = /^(R_TRIG|F_TRIG)_/;

function isEdgeInstanceName(name: string): boolean {
  return EDGE_INSTANCE_RE.test(name);
}

/**
 * Raw-text fallback. Mirrors `siemensToCodesysText` but with Rockwell
 * namespace conventions:
 *
 *   "DB_Alarms".x        → Alarms.x
 *   "DB_Global_Params".y → Parameters.y
 *   "DB_Recipes".z       → Recipes.z
 *   "name"               → name
 *   #name                → name
 */
export function siemensToRockwellText(s: string): string {
  let r = s;
  for (const [db, alias] of Object.entries(ROCKWELL_NAMESPACES)) {
    r = r.replace(new RegExp(`"${db}"\\.(\\w+)`, 'g'), `${alias}.$1`);
  }
  r = r.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1');
  r = r.replace(/#([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
  return r;
}

// ---------- Expression rendering ----------

export function renderExprRockwell(e: ExprIR): string {
  switch (e.kind) {
    case 'Raw':
      return siemensToRockwellText(e.text);
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
      // One-shot bit IS the boolean — no `.Q`.
      return e.instanceName;
    case 'InstanceField':
      // TON_x.Q stays as-is for the POC. See ROCKWELL_TIMER_PSEUDO_IEC.
      return `${renderRef(e.instance)}.${e.fieldName}`;
    case 'Paren':
      return `(${renderExprRockwell(e.inner)})`;
    case 'Unary':
      return `NOT ${renderExprRockwell(e.operand)}`;
    case 'Binary':
      return `${renderExprRockwell(e.left)} ${e.op} ${renderExprRockwell(e.right)}`;
    case 'Call':
      return `${e.fn}(${e.args.map(renderExprRockwell).join(', ')})`;
  }
}

// ---------- Statement rendering ----------

export function renderStmtRockwell(stmt: StmtIR, level: number): string[] {
  switch (stmt.kind) {
    case 'Assign': {
      const c = stmt.comment ? ` // ${stmt.comment}` : '';
      return [
        pad(
          level,
          `${renderRef(stmt.target)} := ${renderExprRockwell(stmt.expr)};${c}`,
        ),
      ];
    }
    case 'Comment':
      return [pad(level, `// ${stmt.text}`)];
    case 'RawStmt':
      return [
        stmt.text === '' ? '' : pad(level, siemensToRockwellText(stmt.text)),
      ];
    case 'If':
      return renderIfRockwell(stmt, level);
    case 'Case':
      return renderCaseRockwell(stmt, level);
    case 'TonCall':
      // Pseudo-IEC TON; flagged by ROCKWELL_TIMER_PSEUDO_IEC at the manifest
      // layer. Studio 5000 import requires Logix TIMER + .DN / .ACC mapping.
      return [
        pad(
          level,
          `${renderRef(stmt.instance)}(IN := ${renderExprRockwell(stmt.inExpr)}, PT := T#${stmt.ptMs}MS); // pseudo-IEC TON`,
        ),
      ];
    case 'FbCall': {
      if (
        stmt.instance.kind === 'fbInstance' &&
        isEdgeInstanceName(stmt.instance.name)
      ) {
        return renderEdgeOneShot(stmt, level);
      }
      const params = stmt.params
        .map((p) => `${p.name} := ${renderExprRockwell(p.value)}`)
        .join(', ');
      const c = stmt.comment ? ` // ${stmt.comment}` : '';
      return [
        pad(
          level,
          `${renderRef(stmt.instance)}(${params});${c}`,
        ),
      ];
    }
  }
}

/**
 * Lower an `FbCall(R_TRIG_x | F_TRIG_x, [CLK := source])` to the Rockwell
 * one-shot bit pattern. Two assigns per edge:
 *
 *   rising:   R_TRIG_x := source AND NOT R_TRIG_x_MEM;
 *             R_TRIG_x_MEM := source;
 *
 *   falling:  F_TRIG_x := NOT source AND F_TRIG_x_MEM;
 *             F_TRIG_x_MEM := source;
 *
 * The companion `_MEM` BOOL is declared by `renderVarSectionRockwell`.
 */
function renderEdgeOneShot(
  stmt: Extract<StmtIR, { kind: 'FbCall' }>,
  level: number,
): string[] {
  if (stmt.instance.kind !== 'fbInstance') return [];
  const name = stmt.instance.name;
  const mem = `${name}_MEM`;
  const clk = stmt.params.find((p) => p.name === 'CLK');
  const src = clk ? renderExprRockwell(clk.value) : 'FALSE';
  const isFalling = name.startsWith('F_TRIG_');
  const trig = isFalling
    ? `${name} := NOT ${src} AND ${mem};`
    : `${name} := ${src} AND NOT ${mem};`;
  return [pad(level, trig), pad(level, `${mem} := ${src};`)];
}

function renderIfRockwell(
  stmt: Extract<StmtIR, { kind: 'If' }>,
  level: number,
): string[] {
  const out: string[] = [];
  out.push(pad(level, `IF ${renderExprRockwell(stmt.cond)} THEN`));
  for (const s of stmt.then) out.push(...renderStmtRockwell(s, level + 1));
  if (stmt.elseIfs) {
    for (const ei of stmt.elseIfs) {
      out.push(pad(level, `ELSIF ${renderExprRockwell(ei.cond)} THEN`));
      for (const s of ei.body) out.push(...renderStmtRockwell(s, level + 1));
    }
  }
  if (stmt.else) {
    out.push(pad(level, 'ELSE'));
    for (const s of stmt.else) out.push(...renderStmtRockwell(s, level + 1));
  }
  out.push(pad(level, 'END_IF;'));
  return out;
}

function renderCaseRockwell(
  stmt: Extract<StmtIR, { kind: 'Case' }>,
  level: number,
): string[] {
  const out: string[] = [];
  out.push(pad(level, `CASE ${renderExprRockwell(stmt.selector)} OF`));
  for (const arm of stmt.arms) {
    const label = arm.label ? `  // ${arm.label}` : '';
    out.push(pad(level + 1, `${arm.value}:${label}`));
    if (arm.body.length === 0) {
      out.push(pad(level + 2, ';'));
    } else {
      for (const s of arm.body) out.push(...renderStmtRockwell(s, level + 2));
    }
  }
  out.push(pad(level, 'ELSE'));
  if (stmt.else && stmt.else.length > 0) {
    for (const s of stmt.else) out.push(...renderStmtRockwell(s, level + 1));
  } else {
    out.push(pad(level + 1, ';'));
  }
  out.push(pad(level, 'END_CASE;'));
  return out;
}

// ---------- VAR sections ----------

/**
 * Render a VAR section. Edge-trigger declarations (`R_TRIG`/`F_TRIG`) expand
 * to two `BOOL` lines: the one-shot bit + its `_MEM` companion. Logix-flavoured
 * type names are produced via `rockwellType`.
 */
export function renderVarSectionRockwell(
  section: VarSectionIR,
  level: number,
): string[] {
  const out: string[] = [pad(level, section.section)];
  for (const d of section.decls) {
    if (d.preComment) out.push(pad(level + 1, `// ${d.preComment}`));
    out.push(...renderVarDeclRockwell(d, level + 1));
  }
  out.push(pad(level, 'END_VAR'));
  return out;
}

function renderVarDeclRockwell(d: VarDeclIR, level: number): string[] {
  if (d.type === 'R_TRIG' || d.type === 'F_TRIG') {
    const note = d.comment
      ? `${d.comment}; one-shot bit (Rockwell POC)`
      : `one-shot bit (Rockwell POC, source: ${d.type})`;
    return [
      pad(level, `${d.name} : BOOL;  // ${note}`),
      pad(level, `${d.name}_MEM : BOOL;  // edge memory for ${d.name}`),
    ];
  }
  const type = rockwellType(d.type);
  const isPseudoTimer = d.type === 'TON';
  const init = d.init !== undefined ? ` := ${d.init}` : '';
  const baseComment = d.comment ?? '';
  const tail = isPseudoTimer
    ? baseComment
      ? `${baseComment}; pseudo-IEC TON (see ROCKWELL_TIMER_PSEUDO_IEC)`
      : 'pseudo-IEC TON (see ROCKWELL_TIMER_PSEUDO_IEC)'
    : baseComment;
  const c = tail ? `  // ${tail}` : '';
  return [pad(level, `${d.name} : ${type}${init};${c}`)];
}

// ---------- Routine top-level ----------

/**
 * Wrap the FunctionBlockIR as a Rockwell ST "routine-like" artifact. Studio
 * 5000 imports routines through L5X; this is a textual stand-in for IR
 * validation. The `ROUTINE … END_ROUTINE` envelope is a documentation marker,
 * not a Logix language construct.
 */
export function renderFunctionBlockRockwell(fb: FunctionBlockIR): string {
  const lines: string[] = [];
  lines.push(`(* ============================================================`);
  lines.push(` * Rockwell ST POC: ${fb.name}`);
  lines.push(` * Generated from FunctionBlockIR by @plccopilot/codegen-siemens`);
  lines.push(` * EXPERIMENTAL — not directly importable to Studio 5000.`);
  lines.push(` * See ROCKWELL_NO_L5X_EXPORT diagnostic.`);
  lines.push(` * ============================================================ *)`);
  for (const hc of fb.headerComments) lines.push(`// ${hc}`);
  lines.push('');
  lines.push(`ROUTINE ${fb.name}`);
  lines.push('');
  for (const sec of fb.varSections) {
    lines.push(...renderVarSectionRockwell(sec, 0));
    lines.push('');
  }
  // Body sits at column 0 — no BEGIN keyword.
  for (const s of fb.body) lines.push(...renderStmtRockwell(s, 0));
  lines.push('');
  lines.push(`END_ROUTINE`);
  lines.push('');
  return lines.join('\n');
}

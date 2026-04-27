import type {
  ExprIR,
  FunctionBlockIR,
  StmtIR,
  VarSectionIR,
} from '../ir/nodes.js';
import { renderRef, renderSymbol } from '../symbols/render-symbol.js';

const UNIT = '    ';

function pad(level: number, line: string): string {
  return line === '' ? '' : UNIT.repeat(level) + line;
}

// ---------- Expression rendering ----------

export function renderExpr(e: ExprIR): string {
  switch (e.kind) {
    case 'Raw':
      return e.text;
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
      return renderSymbol(e.symbol, 'siemens');
    case 'Ref':
      return renderRef(e.ref, 'siemens');
    case 'EdgeRef':
      return `#${e.instanceName}.Q`;
    case 'InstanceField':
      return `${renderRef(e.instance, 'siemens')}.${e.fieldName}`;
    case 'Paren':
      return `(${renderExpr(e.inner)})`;
    case 'Unary':
      return `NOT ${renderExpr(e.operand)}`;
    case 'Binary':
      return `${renderExpr(e.left)} ${e.op} ${renderExpr(e.right)}`;
    case 'Call':
      return `${e.fn}(${e.args.map(renderExpr).join(', ')})`;
  }
}

// ---------- Statement rendering ----------

export function renderStmt(stmt: StmtIR, level: number): string[] {
  switch (stmt.kind) {
    case 'Assign': {
      const c = stmt.comment ? `  // ${stmt.comment}` : '';
      return [
        pad(
          level,
          `${renderRef(stmt.target, 'siemens')} := ${renderExpr(stmt.expr)};${c}`,
        ),
      ];
    }
    case 'Comment':
      return [pad(level, `// ${stmt.text}`)];
    case 'RawStmt':
      return [stmt.text === '' ? '' : pad(level, stmt.text)];
    case 'If':
      return renderIf(stmt, level);
    case 'Case':
      return renderCase(stmt, level);
    case 'TonCall':
      return [
        pad(
          level,
          `${renderRef(stmt.instance, 'siemens')}(IN := ${renderExpr(stmt.inExpr)}, PT := T#${stmt.ptMs}MS);`,
        ),
      ];
    case 'FbCall': {
      const params = stmt.params
        .map((p) => `${p.name} := ${renderExpr(p.value)}`)
        .join(', ');
      const c = stmt.comment ? `  // ${stmt.comment}` : '';
      return [
        pad(
          level,
          `${renderRef(stmt.instance, 'siemens')}(${params});${c}`,
        ),
      ];
    }
  }
}

function renderIf(stmt: Extract<StmtIR, { kind: 'If' }>, level: number): string[] {
  const out: string[] = [];
  out.push(pad(level, `IF ${renderExpr(stmt.cond)} THEN`));
  for (const s of stmt.then) out.push(...renderStmt(s, level + 1));
  if (stmt.elseIfs) {
    for (const ei of stmt.elseIfs) {
      out.push(pad(level, `ELSIF ${renderExpr(ei.cond)} THEN`));
      for (const s of ei.body) out.push(...renderStmt(s, level + 1));
    }
  }
  if (stmt.else) {
    out.push(pad(level, `ELSE`));
    for (const s of stmt.else) out.push(...renderStmt(s, level + 1));
  }
  out.push(pad(level, `END_IF;`));
  return out;
}

function renderCase(stmt: Extract<StmtIR, { kind: 'Case' }>, level: number): string[] {
  const out: string[] = [];
  out.push(pad(level, `CASE ${renderExpr(stmt.selector)} OF`));
  for (const arm of stmt.arms) {
    const label = arm.label ? `  // ${arm.label}` : '';
    out.push(pad(level + 1, `${arm.value}:${label}`));
    if (arm.body.length === 0) {
      out.push(pad(level + 2, ';'));
    } else {
      for (const s of arm.body) out.push(...renderStmt(s, level + 2));
    }
  }
  out.push(pad(level, `ELSE`));
  if (stmt.else && stmt.else.length > 0) {
    for (const s of stmt.else) out.push(...renderStmt(s, level + 1));
  } else {
    out.push(pad(level + 1, ';'));
  }
  out.push(pad(level, `END_CASE;`));
  return out;
}

// ---------- Variable sections ----------

export function renderVarSection(section: VarSectionIR, level: number): string[] {
  const out: string[] = [pad(level, section.section)];
  for (const d of section.decls) {
    if (d.preComment) out.push(pad(level + 1, `// ${d.preComment}`));
    const init = d.init !== undefined ? ` := ${d.init}` : '';
    const comment = d.comment ? `  // ${d.comment}` : '';
    out.push(pad(level + 1, `${d.name} : ${d.type}${init};${comment}`));
  }
  out.push(pad(level, 'END_VAR'));
  return out;
}

// ---------- Function block top-level ----------

const SIEMENS_DEFAULT_ATTRIBUTE = `{ S7_Optimized_Access := 'TRUE' }`;

export function renderFunctionBlock(fb: FunctionBlockIR): string {
  const lines: string[] = [];
  for (const hc of fb.headerComments) lines.push(`// ${hc}`);
  lines.push(`FUNCTION_BLOCK "${fb.name}"`);
  // Core lowering leaves `attributes` empty (vendor-neutral). Siemens output
  // requires `S7_Optimized_Access` for TIA compatibility — inject the default
  // when the IR carries no backend-specific attribute list.
  const attrs = fb.attributes.length > 0 ? fb.attributes : [SIEMENS_DEFAULT_ATTRIBUTE];
  for (const attr of attrs) lines.push(attr);
  lines.push(`VERSION : ${fb.version}`);
  lines.push('');
  for (const sec of fb.varSections) {
    lines.push(...renderVarSection(sec, 0));
    lines.push('');
  }
  lines.push('BEGIN');
  for (const s of fb.body) lines.push(...renderStmt(s, 1));
  lines.push('END_FUNCTION_BLOCK');
  lines.push('');
  return lines.join('\n');
}

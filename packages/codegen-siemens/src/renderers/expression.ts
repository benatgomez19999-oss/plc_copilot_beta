import { analyzeExpression, type Token } from '@plccopilot/pir';
import { CodegenError } from '../types.js';
import { sanitizeSymbol } from '../naming.js';
import {
  localSymbol,
  renderKeyword,
  resolveToSclSymbol,
  type SymbolContext,
} from './symbols.js';

export function renderExpression(expr: string, ctx: SymbolContext): string {
  const a = analyzeExpression(expr);
  if (!a.ok) {
    throw new CodegenError(
      'INVALID_EXPR',
      `Cannot render invalid expression "${expr}": ${a.issues.join('; ')}`,
      {
        path: ctx.path,
        stationId: ctx.station.id,
        symbol: expr,
        hint: 'Fix the expression syntax (operators, parentheses, identifiers) before generating artifacts.',
      },
    );
  }

  const tokens = a.tokens;
  const out: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;

    if (t.type === 'ident') {
      const next = tokens[i + 1];

      if (next && next.type === 'lparen') {
        const { rendered, endIdx } = consumeFunctionCall(tokens, i, ctx);
        out.push(rendered);
        i = endIdx;
        continue;
      }

      const dot = tokens[i + 1];
      const after = tokens[i + 2];
      if (dot && dot.type === 'dot' && after && after.type === 'ident') {
        out.push(resolveToSclSymbol(`${t.value}.${after.value}`, ctx));
        i += 3;
        continue;
      }

      out.push(resolveToSclSymbol(t.value, ctx));
      i++;
      continue;
    }

    if (t.type === 'keyword') {
      out.push(renderKeyword(t.value));
      i++;
      continue;
    }

    if (t.type === 'number') {
      out.push(t.value);
      i++;
      continue;
    }

    switch (t.type) {
      case 'and':
        out.push(' AND ');
        break;
      case 'or':
        out.push(' OR ');
        break;
      case 'not':
        out.push('NOT ');
        break;
      case 'eq':
        out.push(' = ');
        break;
      case 'neq':
        out.push(' <> ');
        break;
      case 'lt':
        out.push(' < ');
        break;
      case 'lte':
        out.push(' <= ');
        break;
      case 'gt':
        out.push(' > ');
        break;
      case 'gte':
        out.push(' >= ');
        break;
      case 'lparen':
        out.push('(');
        break;
      case 'rparen':
        out.push(')');
        break;
      case 'comma':
        out.push(', ');
        break;
      case 'dot':
        break;
      default:
        break;
    }
    i++;
  }

  return collapseWhitespace(out.join(''));
}

function consumeFunctionCall(
  tokens: readonly Token[],
  start: number,
  ctx: SymbolContext,
): { rendered: string; endIdx: number } {
  const name = tokens[start]!.value;
  let i = start + 2;
  const argTokens: Token[][] = [[]];
  let depth = 1;

  while (i < tokens.length && depth > 0) {
    const t = tokens[i]!;
    if (t.type === 'lparen') {
      depth++;
      argTokens[argTokens.length - 1]!.push(t);
    } else if (t.type === 'rparen') {
      depth--;
      if (depth === 0) break;
      argTokens[argTokens.length - 1]!.push(t);
    } else if (t.type === 'comma' && depth === 1) {
      argTokens.push([]);
    } else {
      argTokens[argTokens.length - 1]!.push(t);
    }
    i++;
  }
  const endIdx = i + 1;

  const argLiterals = argTokens
    .map((arr) => arr.map((t) => t.value).join(''))
    .filter((s) => s.length > 0);

  return { rendered: renderFunctionCall(name, argLiterals, ctx), endIdx };
}

function renderFunctionCall(
  name: string,
  args: string[],
  ctx: SymbolContext,
): string {
  if (args.length === 0) {
    throw new CodegenError(
      'INVALID_FN',
      `Function "${name}" requires at least one argument.`,
      {
        path: ctx.path,
        stationId: ctx.station.id,
        symbol: name,
        hint: `Provide an argument: e.g. "${name}(io_signal)" or "${name}(equipment.role)".`,
      },
    );
  }
  const primary = sanitizeSymbol(args[0]!);
  switch (name) {
    case 'rising':
      return `${localSymbol(`R_TRIG_${primary}`)}.Q`;
    case 'falling':
      return `${localSymbol(`F_TRIG_${primary}`)}.Q`;
    case 'edge':
      return `${localSymbol(`EDGE_${primary}`)}.Q`;
    case 'timer_expired':
      return `${localSymbol(primary)}.Q`;
    default:
      throw new CodegenError(
        'UNKNOWN_FN',
        `Function "${name}" is not supported by the v0.1 Siemens generator.`,
        {
          path: ctx.path,
          stationId: ctx.station.id,
          symbol: name,
          hint: 'Use one of the supported functions: rising, falling, edge, timer_expired.',
        },
      );
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/ {2,}/g, ' ').trim();
}

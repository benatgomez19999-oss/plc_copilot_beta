import { tokenize as pirTokenize, type Token as PirToken } from '@plccopilot/pir';
import { makeDiagnostic, type Diagnostic } from './diagnostics.js';
import type { Span } from './ast.js';

export type Token = PirToken;

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
  source: string;
}

export function lex(source: string): LexResult {
  const { tokens, issues } = pirTokenize(source);
  const diagnostics = issues.map((msg) => toLexDiagnostic(msg, source));
  return { tokens, diagnostics, source };
}

export function tokenSpan(t: Token): Span {
  return { start: t.start, end: t.end };
}

function toLexDiagnostic(issue: string, src: string): Diagnostic {
  const match = /position (\d+)/.exec(issue);
  const pos = match
    ? Math.min(Number(match[1]), Math.max(0, src.length - 1))
    : 0;
  const span: Span = {
    start: Math.max(0, pos),
    end: Math.min(pos + 1, Math.max(1, src.length)),
  };
  return makeDiagnostic('error', 'LEX_ERROR', issue, span);
}

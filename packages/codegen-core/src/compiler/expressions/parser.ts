import {
  ast,
  isKeywordName,
  mergeSpans,
  type BinaryOp,
  type Expression,
  type Span,
} from './ast.js';
import { makeDiagnostic, type Diagnostic } from './diagnostics.js';
import { lex, tokenSpan, type Token } from './lexer.js';

export interface ParseResult {
  ast: Expression | null;
  diagnostics: Diagnostic[];
  source: string;
}

export function parseExpression(source: string): ParseResult {
  const { tokens, diagnostics } = lex(source);
  const parser = new Parser(tokens, source, diagnostics);
  const root = parser.parseRoot();
  return { ast: root, diagnostics, source };
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
    private readonly diag: Diagnostic[],
  ) {}

  parseRoot(): Expression | null {
    if (this.tokens.length === 0) {
      this.diag.push(
        makeDiagnostic('error', 'EMPTY_EXPRESSION', 'empty expression', {
          start: 0,
          end: 0,
        }),
      );
      return null;
    }
    const expr = this.parseOr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos]!;
      // Sprint 38 — a stray `)` after a complete expression is a
      // distinct (and more user-actionable) error than generic
      // trailing tokens. Common cases: `a))`, `a + b)`, paste-typo
      // duplicates. Emit `UNEXPECTED_CLOSE_PAREN` for the rparen
      // path so the diagnostic message can be specific; everything
      // else stays on `TRAILING_TOKENS`.
      if (t.type === 'rparen') {
        this.diag.push(
          makeDiagnostic(
            'error',
            'UNEXPECTED_CLOSE_PAREN',
            'unexpected ")" with no matching "("',
            tokenSpan(t),
          ),
        );
      } else {
        this.diag.push(
          makeDiagnostic(
            'error',
            'TRAILING_TOKENS',
            `unexpected token "${t.value}" after expression`,
            tokenSpan(t),
          ),
        );
      }
    }
    return expr;
  }

  // or := and ('||' and)*
  private parseOr(): Expression | null {
    let left = this.parseAnd();
    while (left && this.peek()?.type === 'or') {
      this.consume();
      const right = this.parseAnd();
      if (!right) return left;
      left = ast.bin('||', left, right, mergeSpans(left.span, right.span));
    }
    return left;
  }

  // and := eq ('&&' eq)*
  private parseAnd(): Expression | null {
    let left = this.parseEq();
    while (left && this.peek()?.type === 'and') {
      this.consume();
      const right = this.parseEq();
      if (!right) return left;
      left = ast.bin('&&', left, right, mergeSpans(left.span, right.span));
    }
    return left;
  }

  // eq := cmp (('==' | '!=') cmp)*
  private parseEq(): Expression | null {
    let left = this.parseCmp();
    while (left) {
      const t = this.peek();
      if (t?.type !== 'eq' && t?.type !== 'neq') break;
      const op: BinaryOp = this.consume()!.type === 'eq' ? '==' : '!=';
      const right = this.parseCmp();
      if (!right) return left;
      left = ast.bin(op, left, right, mergeSpans(left.span, right.span));
    }
    return left;
  }

  // cmp := un (('<'|'<='|'>'|'>=') un)*
  private parseCmp(): Expression | null {
    let left = this.parseUnary();
    while (left) {
      const t = this.peek();
      const op = this.asCmpOp(t);
      if (!op) break;
      this.consume();
      const right = this.parseUnary();
      if (!right) return left;
      left = ast.bin(op, left, right, mergeSpans(left.span, right.span));
    }
    return left;
  }

  private asCmpOp(t: Token | undefined): BinaryOp | null {
    if (!t) return null;
    switch (t.type) {
      case 'lt':
        return '<';
      case 'lte':
        return '<=';
      case 'gt':
        return '>';
      case 'gte':
        return '>=';
      default:
        return null;
    }
  }

  // un := '!' un | primary
  private parseUnary(): Expression | null {
    const t = this.peek();
    if (t?.type === 'not') {
      const bang = this.consume()!;
      const operand = this.parseUnary();
      if (!operand) return null;
      return ast.not(operand, mergeSpans(tokenSpan(bang), operand.span));
    }
    return this.parsePrimary();
  }

  // primary := NUMBER | KEYWORD | '(' expr ')' | IDENT ('(' args ')' | '.' IDENT)?
  private parsePrimary(): Expression | null {
    const t = this.peek();
    if (!t) {
      const end = this.src.length;
      this.diag.push(
        makeDiagnostic('error', 'UNEXPECTED_EOF', 'unexpected end of expression', {
          start: end,
          end,
        }),
      );
      return null;
    }

    // '(' expr ')'
    if (t.type === 'lparen') {
      const open = this.consume()!;
      const inner = this.parseOr();
      const closing = this.peek();
      if (closing?.type === 'rparen') {
        this.consume();
        return inner;
      }
      this.diag.push(
        makeDiagnostic(
          'error',
          'UNCLOSED_PAREN',
          'missing closing ")"',
          tokenSpan(open),
        ),
      );
      return inner;
    }

    if (t.type === 'rparen') {
      this.consume();
      this.diag.push(
        makeDiagnostic(
          'error',
          'UNEXPECTED_CLOSE_PAREN',
          'unexpected ")" with no matching "("',
          tokenSpan(t),
        ),
      );
      return null;
    }

    if (t.type === 'number') {
      this.consume();
      const literalType: 'int' | 'real' = /[.eE]/.test(t.value) ? 'real' : 'int';
      const value = literalType === 'int' ? parseInt(t.value, 10) : parseFloat(t.value);
      return ast.literal(value, literalType, tokenSpan(t));
    }

    if (t.type === 'keyword') {
      this.consume();
      if (t.value === 'true' || t.value === 'false') {
        return ast.literal(t.value === 'true', 'bool', tokenSpan(t));
      }
      if (isKeywordName(t.value)) {
        return ast.keyword(t.value, tokenSpan(t));
      }
      // keyword token but not in our enum — treat as ref fallback
      return ast.ref(t.value, tokenSpan(t));
    }

    if (t.type === 'ident') {
      this.consume();
      const next = this.peek();

      if (next?.type === 'lparen') {
        return this.parseCallTail(t);
      }

      if (next?.type === 'dot') {
        this.consume();
        const prop = this.peek();
        if (prop?.type === 'ident') {
          this.consume();
          return ast.member(
            t.value,
            prop.value,
            mergeSpans(tokenSpan(t), tokenSpan(prop)),
          );
        }
        this.diag.push(
          makeDiagnostic(
            'error',
            'UNEXPECTED_TOKEN',
            'expected identifier after "."',
            prop ? tokenSpan(prop) : tokenSpan(t),
          ),
        );
        return ast.ref(t.value, tokenSpan(t));
      }

      return ast.ref(t.value, tokenSpan(t));
    }

    // Any other token at primary position is a syntax error.
    this.consume();
    this.diag.push(
      makeDiagnostic(
        'error',
        'UNEXPECTED_TOKEN',
        `unexpected token "${t.value}"`,
        tokenSpan(t),
      ),
    );
    return null;
  }

  private parseCallTail(calleeTok: Token): Expression {
    this.consume(); // '('
    const args: Expression[] = [];
    if (this.peek()?.type !== 'rparen') {
      const first = this.parseOr();
      if (first) args.push(first);
      while (this.peek()?.type === 'comma') {
        this.consume();
        const next = this.parseOr();
        if (next) args.push(next);
      }
    }

    const closing = this.peek();
    let endSpan: Span;
    if (closing?.type === 'rparen') {
      this.consume();
      endSpan = tokenSpan(closing);
    } else {
      this.diag.push(
        makeDiagnostic(
          'error',
          'UNCLOSED_PAREN',
          `missing ")" in call to "${calleeTok.value}"`,
          tokenSpan(calleeTok),
        ),
      );
      endSpan = tokenSpan(calleeTok);
    }
    return ast.call(
      calleeTok.value,
      args,
      mergeSpans(tokenSpan(calleeTok), endSpan),
    );
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token | undefined {
    return this.tokens[this.pos++];
  }
}

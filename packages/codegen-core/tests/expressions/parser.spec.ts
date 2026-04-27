import { describe, expect, it } from 'vitest';
import { parseExpression } from '@plccopilot/codegen-core';
import type {
  BinaryNode,
  CallNode,
  Expression,
  KeywordNode,
  LiteralNode,
  MemberNode,
  RefNode,
  UnaryNode,
} from '@plccopilot/codegen-core';

function parseOk(src: string): Expression {
  const r = parseExpression(src);
  expect(
    r.diagnostics,
    JSON.stringify(r.diagnostics, null, 2),
  ).toHaveLength(0);
  expect(r.ast).not.toBeNull();
  return r.ast!;
}

describe('parser — literals', () => {
  it('parses integer literal', () => {
    const ast = parseOk('42') as LiteralNode;
    expect(ast.kind).toBe('Literal');
    expect(ast.value).toBe(42);
    expect(ast.literalType).toBe('int');
    expect(ast.span).toEqual({ start: 0, end: 2 });
  });

  it('parses real literal', () => {
    const ast = parseOk('3.14') as LiteralNode;
    expect(ast.literalType).toBe('real');
    expect(ast.value).toBe(3.14);
  });

  it('parses boolean literals via keywords', () => {
    const t = parseOk('true') as LiteralNode;
    expect(t.kind).toBe('Literal');
    expect(t.literalType).toBe('bool');
    expect(t.value).toBe(true);
    const f = parseOk('false') as LiteralNode;
    expect(f.value).toBe(false);
  });
});

describe('parser — primaries', () => {
  it('parses bare ref', () => {
    const ast = parseOk('io_estop') as RefNode;
    expect(ast.kind).toBe('Ref');
    expect(ast.name).toBe('io_estop');
  });

  it('parses member expression', () => {
    const ast = parseOk('cyl01.sensor_extended') as MemberNode;
    expect(ast.kind).toBe('Member');
    expect(ast.object).toBe('cyl01');
    expect(ast.property).toBe('sensor_extended');
  });

  it('parses keyword', () => {
    const ast = parseOk('estop_active') as KeywordNode;
    expect(ast.kind).toBe('Keyword');
    expect(ast.name).toBe('estop_active');
  });

  it('parses function call with one arg', () => {
    const ast = parseOk('rising(sen_part)') as CallNode;
    expect(ast.kind).toBe('Call');
    expect(ast.callee).toBe('rising');
    expect(ast.args).toHaveLength(1);
    expect((ast.args[0] as RefNode).name).toBe('sen_part');
  });

  it('parses function call with multiple args', () => {
    const ast = parseOk('timer_expired(t1, t2)') as CallNode;
    expect(ast.args).toHaveLength(2);
    expect((ast.args[0] as RefNode).name).toBe('t1');
    expect((ast.args[1] as RefNode).name).toBe('t2');
  });

  it('parses empty-arg function call', () => {
    const ast = parseOk('rising()') as CallNode;
    expect(ast.callee).toBe('rising');
    expect(ast.args).toHaveLength(0);
  });
});

describe('parser — operators + precedence', () => {
  it('parses unary NOT', () => {
    const ast = parseOk('!io_ok') as UnaryNode;
    expect(ast.kind).toBe('Unary');
    expect(ast.op).toBe('!');
    expect((ast.operand as RefNode).name).toBe('io_ok');
  });

  it('&& binds tighter than ||', () => {
    const ast = parseOk('a || b && c') as BinaryNode;
    expect(ast.kind).toBe('Binary');
    expect(ast.op).toBe('||');
    expect((ast.left as RefNode).name).toBe('a');
    const right = ast.right as BinaryNode;
    expect(right.op).toBe('&&');
    expect((right.left as RefNode).name).toBe('b');
    expect((right.right as RefNode).name).toBe('c');
  });

  it('== and != group tighter than && / ||', () => {
    const ast = parseOk('mode == auto && start_cmd') as BinaryNode;
    expect(ast.op).toBe('&&');
    const left = ast.left as BinaryNode;
    expect(left.op).toBe('==');
    expect((left.left as KeywordNode).name).toBe('mode');
    expect((left.right as KeywordNode).name).toBe('auto');
  });

  it('comparison operators tighter than equality', () => {
    const ast = parseOk('x < 10 == true') as BinaryNode;
    expect(ast.op).toBe('==');
    const left = ast.left as BinaryNode;
    expect(left.op).toBe('<');
  });

  it('parens override precedence', () => {
    const ast = parseOk('(a || b) && c') as BinaryNode;
    expect(ast.op).toBe('&&');
    expect((ast.left as BinaryNode).op).toBe('||');
  });

  it('parses deeply nested expression', () => {
    const ast = parseOk(
      'estop_active || (io_part_sensor && cyl01.sensor_extended)',
    ) as BinaryNode;
    expect(ast.op).toBe('||');
    expect((ast.left as KeywordNode).name).toBe('estop_active');
    const right = ast.right as BinaryNode;
    expect(right.op).toBe('&&');
    expect((right.right as MemberNode).property).toBe('sensor_extended');
  });
});

describe('parser — error recovery', () => {
  it('reports empty input', () => {
    const r = parseExpression('');
    expect(r.ast).toBeNull();
    expect(r.diagnostics.some((d) => d.code === 'EMPTY_EXPRESSION')).toBe(true);
  });

  it('reports unclosed paren', () => {
    const r = parseExpression('(a && b');
    expect(r.diagnostics.some((d) => d.code === 'UNCLOSED_PAREN')).toBe(true);
  });

  it('reports unexpected close paren', () => {
    const r = parseExpression('a))');
    expect(
      r.diagnostics.some((d) => d.code === 'UNEXPECTED_CLOSE_PAREN'),
    ).toBe(true);
  });

  it('reports trailing tokens', () => {
    const r = parseExpression('a b');
    expect(r.diagnostics.some((d) => d.code === 'TRAILING_TOKENS')).toBe(true);
  });

  it('surfaces lex errors as LEX_ERROR with span', () => {
    const r = parseExpression('a @ b');
    const lex = r.diagnostics.find((d) => d.code === 'LEX_ERROR');
    expect(lex).toBeDefined();
    // `Diagnostic.span` is structurally optional, so assert it's
    // present before reading offsets — the test's claim is exactly
    // that the lexer attaches a span to LEX_ERROR diagnostics.
    expect(lex!.span).toBeDefined();
    expect(lex!.span!.start).toBeGreaterThanOrEqual(0);
  });

  it('reports unclosed paren inside function call', () => {
    const r = parseExpression('rising(x');
    expect(r.diagnostics.some((d) => d.code === 'UNCLOSED_PAREN')).toBe(true);
  });
});

export interface Span {
  start: number;
  end: number;
}

export type KeywordName =
  | 'mode'
  | 'start_cmd'
  | 'release_cmd'
  | 'estop_active'
  | 'auto'
  | 'manual'
  | 'setup'
  | 'maintenance';

export interface LiteralNode {
  kind: 'Literal';
  value: number | boolean;
  literalType: 'int' | 'real' | 'bool';
  span: Span;
}

export interface KeywordNode {
  kind: 'Keyword';
  name: KeywordName;
  span: Span;
}

export interface RefNode {
  kind: 'Ref';
  name: string;
  span: Span;
}

export interface MemberNode {
  kind: 'Member';
  object: string;
  property: string;
  span: Span;
}

export interface CallNode {
  kind: 'Call';
  callee: string;
  args: Expression[];
  span: Span;
}

export type UnaryOp = '!';

export interface UnaryNode {
  kind: 'Unary';
  op: UnaryOp;
  operand: Expression;
  span: Span;
}

export type BinaryOp = '&&' | '||' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface BinaryNode {
  kind: 'Binary';
  op: BinaryOp;
  left: Expression;
  right: Expression;
  span: Span;
}

export type Expression =
  | LiteralNode
  | KeywordNode
  | RefNode
  | MemberNode
  | CallNode
  | UnaryNode
  | BinaryNode;

export function mergeSpans(a: Span, b: Span): Span {
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
  };
}

export function isKeywordName(value: string): value is KeywordName {
  return (
    value === 'mode' ||
    value === 'start_cmd' ||
    value === 'release_cmd' ||
    value === 'estop_active' ||
    value === 'auto' ||
    value === 'manual' ||
    value === 'setup' ||
    value === 'maintenance'
  );
}

export const ast = {
  literal(
    value: number | boolean,
    literalType: 'int' | 'real' | 'bool',
    span: Span,
  ): LiteralNode {
    return { kind: 'Literal', value, literalType, span };
  },
  keyword(name: KeywordName, span: Span): KeywordNode {
    return { kind: 'Keyword', name, span };
  },
  ref(name: string, span: Span): RefNode {
    return { kind: 'Ref', name, span };
  },
  member(object: string, property: string, span: Span): MemberNode {
    return { kind: 'Member', object, property, span };
  },
  call(callee: string, args: Expression[], span: Span): CallNode {
    return { kind: 'Call', callee, args, span };
  },
  not(operand: Expression, span: Span): UnaryNode {
    return { kind: 'Unary', op: '!', operand, span };
  },
  bin(
    op: BinaryOp,
    left: Expression,
    right: Expression,
    span: Span,
  ): BinaryNode {
    return { kind: 'Binary', op, left, right, span };
  },
};

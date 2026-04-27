export type SclType =
  | 'Bool'
  | 'Int'
  | 'DInt'
  | 'Real'
  | 'Time'
  | 'TimerRef'
  | 'Unknown';

export const SCL_TYPES: readonly SclType[] = [
  'Bool',
  'Int',
  'DInt',
  'Real',
  'Time',
  'TimerRef',
  'Unknown',
];

export function isNumeric(t: SclType): boolean {
  return t === 'Int' || t === 'DInt' || t === 'Real';
}

/**
 * Two types can be compared with == / != if they share the numeric ladder,
 * are both booleans, or are strictly equal. Unknown is permissive (it already
 * carries an error diagnostic).
 */
export function isComparable(left: SclType, right: SclType): boolean {
  if (left === 'Unknown' || right === 'Unknown') return true;
  if (left === 'Bool' && right === 'Bool') return true;
  if (isNumeric(left) && isNumeric(right)) return true;
  return left === right;
}

/**
 * Two types can be ordered with < / <= / > / >= if both are numeric.
 */
export function isOrderable(left: SclType, right: SclType): boolean {
  if (left === 'Unknown' || right === 'Unknown') return true;
  return isNumeric(left) && isNumeric(right);
}

/**
 * SCL-style numeric widening: Int < DInt < Real. Returns Unknown for
 * non-numeric operands.
 */
export function commonNumericType(a: SclType, b: SclType): SclType {
  if (!isNumeric(a) || !isNumeric(b)) return 'Unknown';
  const rank: Record<string, number> = { Int: 0, DInt: 1, Real: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

export interface FunctionSig {
  paramTypes: readonly SclType[];
  returnType: SclType;
  /**
   * When true, argument types are NOT enforced. Used for edge / timer
   * functions whose "arg" is a symbolic handle rather than a value.
   * Arity is still checked.
   */
  opaqueArgs?: boolean;
}

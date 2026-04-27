/**
 * Sprint 47 — minimal JSON-Schema validator, scoped to the subset
 * the CLI's published schemas (`cli-result`,
 * `serialized-compiler-error`) actually use.
 *
 * INTENTIONALLY NOT A GENERAL-PURPOSE VALIDATOR.
 *
 * Supported keywords:
 *   - $defs / $ref (local `#/$defs/Name` only)
 *   - oneOf
 *   - type: object | array | string | number | integer | boolean
 *   - properties / required / additionalProperties: false
 *   - items
 *   - enum / const
 *   - minimum (numeric)
 *   - minLength (strings)
 *   - format: 'date-time' (pragmatic: must parse via `Date.parse`)
 *
 * NOT supported (returns an `unsupported schema keyword` issue if
 * encountered):
 *   - anyOf / allOf / not
 *   - patternProperties / additionalProperties as a sub-schema
 *   - external $ref / nested $ref roots
 *   - draft 2020-12 vocabularies in general
 *
 * The validator never throws on well-formed inputs. It returns an
 * `issues[]` list scoped by JSON-pointer-style paths so test
 * assertions can pin both shape failures and the exact location.
 */

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  ok: boolean;
  issues: SchemaValidationIssue[];
}

interface JsonSchema {
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  oneOf?: JsonSchema[];
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  minLength?: number;
  format?: string;
  // Allowed metadata, ignored by validator:
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
}

interface ValidatorContext {
  defs: Record<string, JsonSchema>;
  issues: SchemaValidationIssue[];
}

const ISO_DATE_TIME = (v: string): boolean =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
): SchemaValidationResult {
  const root = schema as JsonSchema;
  const ctx: ValidatorContext = {
    defs: (root.$defs ?? {}) as Record<string, JsonSchema>,
    issues: [],
  };
  validate(value, root, '$', ctx);
  return { ok: ctx.issues.length === 0, issues: ctx.issues };
}

function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidatorContext,
): void {
  if (schema.$ref !== undefined) {
    validateRef(value, schema.$ref, path, ctx);
    return;
  }
  if (schema.oneOf) {
    validateOneOf(value, schema.oneOf, path, ctx);
    return;
  }
  if (schema.const !== undefined) {
    if (!deepEqual(value, schema.const)) {
      ctx.issues.push({
        path,
        message: `expected const ${stringify(schema.const)}, got ${stringify(value)}`,
      });
    }
    return;
  }
  if (schema.enum) {
    if (!schema.enum.some((v) => deepEqual(v, value))) {
      ctx.issues.push({
        path,
        message: `value ${stringify(value)} not in enum [${schema.enum.map(stringify).join(', ')}]`,
      });
    }
    return;
  }

  // Detect unsupported keywords up front so silently-passing schemas
  // never disguise a contract gap.
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(k)) {
      ctx.issues.push({
        path,
        message: `unsupported schema keyword "${k}" at ${path}`,
      });
      return;
    }
  }

  if (schema.type === undefined) {
    // No type, no further checks. Acceptable for refs/oneOf paths
    // already handled above.
    return;
  }

  switch (schema.type) {
    case 'string':
      validateString(value, schema, path, ctx);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        ctx.issues.push({
          path,
          message: `expected integer, got ${typeofValue(value)}`,
        });
        return;
      }
      validateNumeric(value, schema, path, ctx);
      return;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        ctx.issues.push({
          path,
          message: `expected number, got ${typeofValue(value)}`,
        });
        return;
      }
      validateNumeric(value, schema, path, ctx);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        ctx.issues.push({
          path,
          message: `expected boolean, got ${typeofValue(value)}`,
        });
      }
      return;
    case 'array':
      validateArray(value, schema, path, ctx);
      return;
    case 'object':
      validateObject(value, schema, path, ctx);
      return;
    default:
      ctx.issues.push({
        path,
        message: `unsupported type "${schema.type}"`,
      });
  }
}

const SUPPORTED_KEYWORDS = new Set([
  '$defs',
  '$ref',
  '$schema',
  '$id',
  'title',
  'description',
  'oneOf',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'minLength',
  'format',
]);

function validateRef(
  value: unknown,
  ref: string,
  path: string,
  ctx: ValidatorContext,
): void {
  const prefix = '#/$defs/';
  if (!ref.startsWith(prefix)) {
    ctx.issues.push({
      path,
      message: `unsupported $ref "${ref}" — only local "#/$defs/Name" refs are supported`,
    });
    return;
  }
  const name = ref.slice(prefix.length);
  const target = ctx.defs[name];
  if (!target) {
    ctx.issues.push({
      path,
      message: `$ref "${ref}" does not resolve in $defs`,
    });
    return;
  }
  validate(value, target, path, ctx);
}

function validateOneOf(
  value: unknown,
  branches: JsonSchema[],
  path: string,
  ctx: ValidatorContext,
): void {
  let matches = 0;
  let lastBranchIssues: SchemaValidationIssue[] = [];
  for (let i = 0; i < branches.length; i++) {
    const branchCtx: ValidatorContext = { defs: ctx.defs, issues: [] };
    validate(value, branches[i]!, `${path}.oneOf[${i}]`, branchCtx);
    if (branchCtx.issues.length === 0) {
      matches += 1;
    } else {
      lastBranchIssues = branchCtx.issues;
    }
  }
  if (matches === 1) return;
  if (matches === 0) {
    ctx.issues.push({
      path,
      message: `oneOf: value matched zero branches (last branch reported ${lastBranchIssues.length} issue(s); first: ${
        lastBranchIssues[0]?.message ?? '<unknown>'
      })`,
    });
    return;
  }
  ctx.issues.push({
    path,
    message: `oneOf: value matched ${matches} branches; expected exactly one`,
  });
}

function validateString(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidatorContext,
): void {
  if (typeof value !== 'string') {
    ctx.issues.push({
      path,
      message: `expected string, got ${typeofValue(value)}`,
    });
    return;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    ctx.issues.push({
      path,
      message: `string length ${value.length} below minLength ${schema.minLength}`,
    });
  }
  if (schema.format === 'date-time' && !ISO_DATE_TIME(value)) {
    ctx.issues.push({
      path,
      message: `string "${value}" is not a valid date-time`,
    });
  }
}

function validateNumeric(
  value: number,
  schema: JsonSchema,
  path: string,
  ctx: ValidatorContext,
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    ctx.issues.push({
      path,
      message: `value ${value} below minimum ${schema.minimum}`,
    });
  }
}

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidatorContext,
): void {
  if (!Array.isArray(value)) {
    ctx.issues.push({
      path,
      message: `expected array, got ${typeofValue(value)}`,
    });
    return;
  }
  if (schema.items) {
    for (let i = 0; i < value.length; i++) {
      validate(value[i], schema.items, `${path}[${i}]`, ctx);
    }
  }
}

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string,
  ctx: ValidatorContext,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.issues.push({
      path,
      message: `expected object, got ${typeofValue(value)}`,
    });
    return;
  }
  const obj = value as Record<string, unknown>;
  const props = schema.properties ?? {};

  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in obj)) {
        ctx.issues.push({
          path,
          message: `missing required property "${key}"`,
        });
      }
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    const propSchema = props[key];
    if (propSchema) {
      validate(val, propSchema, `${path}.${key}`, ctx);
    } else if (schema.additionalProperties === false) {
      ctx.issues.push({
        path,
        message: `unexpected additional property "${key}"`,
      });
    }
  }
}

// =============================================================================
// helpers
// =============================================================================

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in bo)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

function typeofValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

# PIR-Expr v0.1 — Grammar Reference

Mini-grammar used for `Transition.guard`, `Transition.trigger`, `Alarm.when`,
`Interlock.when` and `SafetyGroup.trigger` in PIR v0.1.

The expression layer in v0.1 is **lex-only** — there is no AST. The validator
tokenizes the string, rejects invalid characters and unbalanced parentheses,
and resolves top-level symbol references and function names against the
surrounding PIR context.

---

## 1. Character set

| Category          | Chars                                   |
| ----------------- | --------------------------------------- |
| letters           | `a-zA-Z`                                |
| digits            | `0-9`                                   |
| underscore        | `_`                                     |
| separators        | `.` `,`                                 |
| paren             | `(` `)`                                 |
| operator glyphs   | `& | = ! < > `                          |
| whitespace        | space, tab, `\r`, `\n`                  |

Any other character → lex issue `invalid character`.

---

## 2. Operators

Boolean and comparison only. Precedence is irrelevant in v0.1 because we
do not build an AST; a future v0.2 will parse to IR.

| Token | Lexeme |
| ----- | ------ |
| AND   | `&&`   |
| OR    | `\|\|` |
| NOT   | `!`    |
| EQ    | `==`   |
| NEQ   | `!=`   |
| LT    | `<`    |
| LTE   | `<=`   |
| GT    | `>`    |
| GTE   | `>=`   |

Arithmetic (`+`, `-`, `*`, `/`) is **not** part of v0.1.

---

## 3. Literals and identifiers

- `NUMBER`  — `[0-9]+(\.[0-9]+)?`
- `IDENT`   — `[a-zA-Z_][a-zA-Z0-9_]*`

If an `IDENT` matches a reserved keyword it is reclassified as `KEYWORD`.

---

## 4. Reserved keywords

Resolved directly; never refer to any PIR entity.

```
mode start_cmd release_cmd estop_active
auto manual setup maintenance
true false
```

---

## 5. Whitelisted functions

Only these names may appear in call position (`IDENT '(' ... ')'`):

```
timer_expired(...)
rising(...)
falling(...)
edge(...)
```

Any other call is an `R-EX-01` error.

In v0.1, **arguments are opaque**: they are captured as raw strings and
**not** resolved against the PIR context. Semantics per function (e.g.
`timer_expired` takes an internal timer name; `rising`/`falling`/`edge`
take a sensor-like signal) are enforced in v0.2.

---

## 6. Symbol references (top-level, i.e. NOT inside a function call)

| Form                     | Resolves to                           |
| ------------------------ | ------------------------------------- |
| `io_id`                  | `Machine.io[*].id`                    |
| `parameter_id`           | `Machine.parameters[*].id`            |
| `equipment_id.role_name` | `Machine.*.equipment[id].io_bindings` via `EQUIPMENT_SHAPES` |
| `keyword`                | `EXPR_KEYWORDS`                       |

`role_name` must be a **known role** of the equipment's shape
(either `required_io` or `optional_io`), not an arbitrary binding key.

A top-level bare equipment id (e.g. `cyl01` without a role) **does not**
resolve in v0.1 and is reported as unresolved.

---

## 7. Examples

Valid:

```
estop_active
mode == auto
!estop_active && rising(io_part_sensor)
cyl01.sensor_extended
timer_expired(hold_timer)
(mode == auto) || (mode == manual)
p_weld_time > 1000
```

Invalid (rule cited):

```
foo(x)                           # R-EX-01 — function not whitelisted
(mode == auto                    # R-EX-01 — unbalanced paren
io_ghost                         # R-EX-01 — unknown io reference
cyl01.ghost_role                 # R-EX-01 — unknown role on equipment
Cyl01.sensor_extended            # R-EX-01 — invalid id format (uppercase)
```

---

## 8. What v0.1 does NOT do

- No AST, no precedence enforcement.
- No type checking of operands (bool vs numeric).
- No semantic checking of function arguments.
- No constant folding or dead-branch detection.

These are deferred to PIR v0.2 (`src/domain/expressions/parser.ts`).

/**
 * Minimal SCL / Structured-Text language registration for Monaco.
 *
 * Goals:
 *   - syntax highlighting good enough that an integrator can read an FB
 *     listing comfortably
 *   - `(* … *)` block comments + `// …` line comments
 *   - keywords highlighted (no parser-level correctness — just keyword set)
 *   - Siemens-specific quirks: `#name` FB-local refs, `"name"` PLC tags,
 *     `T#5000MS` time literals
 *
 * Non-goals:
 *   - real grammar / parser
 *   - autocomplete
 *   - validation / linting
 *   - hover info
 *
 * Tested via a structural mock that captures `monaco.languages.*` calls; we
 * never instantiate Monaco itself in unit tests.
 */

// =============================================================================
// Structural type — the slice of the Monaco API we use. Real Monaco satisfies
// this without casts; the test mock fills it with `vi.fn()` stubs.
// =============================================================================

// Sprint 37 — declared with **method shorthand** rather than
// arrow-property syntax. TypeScript checks method signatures with
// bivariance, so the real `monaco-editor` `languages.register`
// (which takes `extensions?: string[]` mutable, not `readonly`)
// can satisfy this host without losing the readonly defensiveness
// at the local call sites that pass keyword arrays. Same applies
// to the other two methods, which take `unknown` payloads.
export interface MonacoLanguagesAPI {
  register(config: {
    id: string;
    extensions?: readonly string[];
    aliases?: readonly string[];
  }): void;
  setMonarchTokensProvider(id: string, definition: unknown): void;
  setLanguageConfiguration(id: string, config: unknown): void;
}

export interface MonacoLanguageHost {
  languages: MonacoLanguagesAPI;
}

// =============================================================================
// Shared keyword set — Siemens SCL and IEC 61131-3 ST share most identifiers.
// Case-insensitive matching is enabled in the Monarch definition, so users
// can write either `IF…THEN` or `if…then`.
// =============================================================================

const KEYWORDS: readonly string[] = [
  // FB / DB / TYPE envelopes
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'FUNCTION', 'END_FUNCTION',
  'PROGRAM', 'END_PROGRAM',
  'DATA_BLOCK', 'END_DATA_BLOCK',
  'TYPE', 'END_TYPE',
  'STRUCT', 'END_STRUCT',
  'ROUTINE', 'END_ROUTINE',
  // VAR sections
  'VAR', 'END_VAR',
  'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL',
  'CONSTANT', 'NON_RETAIN', 'RETAIN', 'PERSISTENT',
  // Control flow
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'WHILE', 'DO', 'END_WHILE',
  'FOR', 'TO', 'BY', 'END_FOR',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'EXIT', 'CONTINUE', 'RETURN',
  'BEGIN', 'END',
  // Booleans / literals
  'TRUE', 'FALSE', 'NULL',
  // Operators (textual)
  'AND', 'OR', 'NOT', 'XOR', 'MOD', 'DIV',
  // FB instances commonly seen
  'TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'CTU', 'CTD', 'SR', 'RS',
  // Versioning / metadata keywords
  'VERSION',
  // Common parameter names that read as keywords
  'IN', 'PT', 'CLK', 'Q', 'ET',
  // Types — both Siemens spellings (`Bool`, `DInt`) and IEC spellings (`BOOL`, `DINT`)
  'BOOL', 'INT', 'DINT', 'REAL', 'WORD', 'DWORD', 'LWORD', 'STRING',
  'TIME', 'DATE', 'TIME_OF_DAY', 'DATE_AND_TIME',
  'Bool', 'Int', 'DInt', 'Real', 'Word', 'DWord', 'String',
  'Variant',
];

// =============================================================================
// Monarch tokenizer — applied verbatim to both `scl` and `structured-text`.
// =============================================================================

function buildMonarchDefinition(tokenPostfix: string): Record<string, unknown> {
  return {
    defaultToken: '',
    tokenPostfix,
    ignoreCase: true,
    keywords: KEYWORDS,

    brackets: [
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '{', close: '}', token: 'delimiter.curly' },
    ],

    tokenizer: {
      root: [
        // Block comments (Siemens / IEC style)
        [/\(\*/, { token: 'comment', next: '@blockComment' }],
        // Line comments
        [/\/\/.*$/, 'comment'],

        // Siemens FB-local prefix:  #identifier
        [/#[a-zA-Z_]\w*/, 'variable.predefined'],

        // Siemens-quoted PLC tag:  "identifier"  or  "DB_X".field
        [/"[a-zA-Z_][\w]*"/, 'string'],
        // Single-quoted IEC string literal
        [/'(?:[^'\\]|\\.)*'/, 'string'],
        // Multi-line / fallback double-quoted (rare in SCL but tolerated)
        [/"/, { token: 'string.quote', next: '@dqString' }],

        // IEC time / date literals — T#5000MS, T#1H30M, D#2024-01-01, …
        [/[TtDdLl]#[\w_:.-]+/, 'number.hex'],

        // Numbers (real / int / hex)
        [/16#[0-9A-Fa-f_]+/, 'number.hex'],
        [/2#[01_]+/, 'number.binary'],
        [/[0-9]+\.[0-9]+([eE][-+]?[0-9]+)?/, 'number.float'],
        [/[0-9]+/, 'number'],

        // Identifiers / keywords
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier',
          },
        }],

        // Operators
        [/:=|<>|<=|>=|=>|->/, 'operator'],
        [/[+\-*/<>=]/, 'operator'],

        // Delimiters
        [/[;,.:]/, 'delimiter'],
        [/[()[\]{}]/, '@brackets'],

        // Whitespace
        [/\s+/, 'white'],
      ],

      blockComment: [
        [/\*\)/, { token: 'comment', next: '@pop' }],
        [/[^*]+/, 'comment'],
        [/\*/, 'comment'],
      ],

      dqString: [
        [/[^"]+/, 'string'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],
    },
  };
}

// =============================================================================
// Language configuration — comments / brackets / auto-closing pairs.
// =============================================================================

const LANGUAGE_CONFIG: Record<string, unknown> = {
  comments: {
    lineComment: '//',
    blockComment: ['(*', '*)'],
  },
  brackets: [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '(*', close: '*)' },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

// =============================================================================
// Public entry point. Idempotent: Monaco silently merges duplicate
// `setMonarchTokensProvider` calls, and `register` for the same id is a
// no-op when the id is already known. Safe to call from multiple `beforeMount`
// callbacks.
// =============================================================================

export function registerPlcLanguages(monaco: MonacoLanguageHost): void {
  // Siemens SCL
  monaco.languages.register({
    id: 'scl',
    extensions: ['.scl'],
    aliases: ['SCL', 'Structured Control Language', 'siemens-scl'],
  });
  monaco.languages.setMonarchTokensProvider(
    'scl',
    buildMonarchDefinition('.scl'),
  );
  monaco.languages.setLanguageConfiguration('scl', LANGUAGE_CONFIG);

  // Generic IEC 61131-3 ST (Codesys / Rockwell artifacts use this)
  monaco.languages.register({
    id: 'structured-text',
    extensions: ['.st'],
    aliases: ['ST', 'IEC 61131-3 ST', 'Structured Text'],
  });
  monaco.languages.setMonarchTokensProvider(
    'structured-text',
    buildMonarchDefinition('.st'),
  );
  monaco.languages.setLanguageConfiguration(
    'structured-text',
    LANGUAGE_CONFIG,
  );
}

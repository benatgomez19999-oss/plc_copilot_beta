import type { BackendId } from '../backend.js';
import type { RefIR } from '../ir/nodes.js';
import type { ResolvedSymbol, SymbolStorage } from './types.js';

/**
 * A vendor-neutral mapping from canonical IR DB names (e.g. `DB_Alarms`) to
 * a backend-specific namespace alias. Each backend package owns its own map
 * and passes it to `renderRef` / `renderSymbol` / `renderStorage` at render
 * time. Core does NOT hardcode any backend namespace.
 *
 * The default empty map yields identity behaviour (the IR name is rendered
 * verbatim), which is what Siemens consumes — its convention is
 * `"DB_Alarms".x`, no renaming needed.
 */
export type BackendNamespaceMap = Readonly<Record<string, string>>;

const EMPTY_NAMESPACES: BackendNamespaceMap = Object.freeze({});

/**
 * Look up a canonical IR DB name in a backend-supplied namespace map. Falls
 * back to identity when the map omits an entry (or no map is provided).
 */
export function dbNamespaceFor(
  dbName: string,
  namespaces: BackendNamespaceMap = EMPTY_NAMESPACES,
): string {
  return namespaces[dbName] ?? dbName;
}

export function renderSymbol(
  sym: ResolvedSymbol,
  backend: BackendId,
  namespaces: BackendNamespaceMap = EMPTY_NAMESPACES,
): string {
  return renderStorage(sym.storage, backend, namespaces);
}

export function renderStorage(
  s: SymbolStorage,
  backend: BackendId,
  namespaces: BackendNamespaceMap = EMPTY_NAMESPACES,
): string {
  switch (s.kind) {
    case 'local':
      return backend === 'siemens' ? `#${s.name}` : s.name;
    case 'global':
      return backend === 'siemens' ? `"${s.name}"` : s.name;
    case 'dbField': {
      const ns = namespaces[s.dbName] ?? s.dbName;
      if (backend === 'siemens') return `"${ns}".${s.fieldName}`;
      return `${ns}.${s.fieldName}`;
    }
    case 'literal':
      return s.text;
  }
}

export function renderRef(
  r: RefIR,
  backend: BackendId,
  namespaces: BackendNamespaceMap = EMPTY_NAMESPACES,
): string {
  switch (r.kind) {
    case 'local':
      return backend === 'siemens' ? `#${r.name}` : r.name;
    case 'global':
      return backend === 'siemens' ? `"${r.name}"` : r.name;
    case 'dbField': {
      const ns = namespaces[r.dbName] ?? r.dbName;
      if (backend === 'siemens') return `"${ns}".${r.fieldName}`;
      return `${ns}.${r.fieldName}`;
    }
    case 'fbInstance':
      return backend === 'siemens' ? `#${r.name}` : r.name;
  }
}

/**
 * Convert a SymbolStorage into an assignable RefIR. Throws on `literal`
 * because literals (mode constants like `'1'`) are not assignable.
 */
export function storageToRef(s: SymbolStorage): RefIR {
  switch (s.kind) {
    case 'local':
      return { kind: 'local', name: s.name };
    case 'global':
      return { kind: 'global', name: s.name };
    case 'dbField':
      return { kind: 'dbField', dbName: s.dbName, fieldName: s.fieldName };
    case 'literal':
      throw new Error(
        `cannot use literal storage "${s.text}" as an assignable reference`,
      );
  }
}

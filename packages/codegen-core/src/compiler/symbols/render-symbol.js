const EMPTY_NAMESPACES = Object.freeze({});
/**
 * Look up a canonical IR DB name in a backend-supplied namespace map. Falls
 * back to identity when the map omits an entry (or no map is provided).
 */
export function dbNamespaceFor(dbName, namespaces = EMPTY_NAMESPACES) {
    return namespaces[dbName] ?? dbName;
}
export function renderSymbol(sym, backend, namespaces = EMPTY_NAMESPACES) {
    return renderStorage(sym.storage, backend, namespaces);
}
export function renderStorage(s, backend, namespaces = EMPTY_NAMESPACES) {
    switch (s.kind) {
        case 'local':
            return backend === 'siemens' ? `#${s.name}` : s.name;
        case 'global':
            return backend === 'siemens' ? `"${s.name}"` : s.name;
        case 'dbField': {
            const ns = namespaces[s.dbName] ?? s.dbName;
            if (backend === 'siemens')
                return `"${ns}".${s.fieldName}`;
            return `${ns}.${s.fieldName}`;
        }
        case 'literal':
            return s.text;
    }
}
export function renderRef(r, backend, namespaces = EMPTY_NAMESPACES) {
    switch (r.kind) {
        case 'local':
            return backend === 'siemens' ? `#${r.name}` : r.name;
        case 'global':
            return backend === 'siemens' ? `"${r.name}"` : r.name;
        case 'dbField': {
            const ns = namespaces[r.dbName] ?? r.dbName;
            if (backend === 'siemens')
                return `"${ns}".${r.fieldName}`;
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
export function storageToRef(s) {
    switch (s.kind) {
        case 'local':
            return { kind: 'local', name: s.name };
        case 'global':
            return { kind: 'global', name: s.name };
        case 'dbField':
            return { kind: 'dbField', dbName: s.dbName, fieldName: s.fieldName };
        case 'literal':
            throw new Error(`cannot use literal storage "${s.text}" as an assignable reference`);
    }
}

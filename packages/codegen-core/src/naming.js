/**
 * Vendor-neutral naming helpers consumed by the IR / lowering layer. Backend
 * packages keep their own `naming.ts` (or equivalent) for filesystem paths,
 * directory names, file extensions, manifest filenames, etc.
 *
 * Anything that lives here must be free of backend-lexical conventions:
 *   - no directory prefixes (`siemens/`, `codesys/`, `rockwell/`)
 *   - no file extensions (`.scl`, `.st`, `.csv`)
 *   - no DB / GVL / namespace constants
 */
export function toPascalCase(id) {
    return id
        .split(/[_\-\s.]+/)
        .filter((s) => s.length > 0)
        .map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase())
        .join('');
}
export function stationName(station) {
    return toPascalCase(station.id);
}
export function stationFbName(station) {
    return `FB_${stationName(station)}`;
}
export function equipmentName(eq) {
    const cs = eq.code_symbol?.trim();
    if (cs && cs.length > 0)
        return cs;
    return toPascalCase(eq.id);
}
export function sanitizeSymbol(raw) {
    return raw.replace(/[^A-Za-z0-9_]/g, '_');
}
export function basename(path) {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(idx + 1) : path;
}

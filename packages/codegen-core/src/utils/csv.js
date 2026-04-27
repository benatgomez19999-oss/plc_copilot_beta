// ; delimited CSV builder for Siemens-style tag exports.
// Strips CR/LF/TAB and replaces ; with , so every row stays on a single line
// with exactly (fields.length - 1) separators.
export function escapeCsvField(raw) {
    return raw.replace(/[\r\n\t]+/g, ' ').replace(/;/g, ',').trim();
}
export function toCsvRow(fields) {
    return fields.map(escapeCsvField).join(';');
}
export function buildCsv(header, rows) {
    const lines = [toCsvRow(header)];
    for (const r of rows)
        lines.push(toCsvRow(r));
    return lines.join('\n') + '\n';
}

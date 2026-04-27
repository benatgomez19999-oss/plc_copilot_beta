/**
 * Vendor-neutral tag-table builder. Walks the PIR machine and produces the
 * canonical row list that every backend can render in its own format
 * (Siemens CSV, Codesys GVL list, Rockwell controller-tag table, …).
 *
 * The output carries:
 *   - logical names (no `siemens/`, no `.csv`)
 *   - canonical IR type spellings (`Bool` / `Int` / `DInt` / `Real` / `Variant`)
 *   - structured PIR addresses (no `%I0.0` rendering — that's vendor-specific)
 *
 * Alarms are intentionally NOT emitted as loose tag rows — they live in
 * `DB_Alarms` (or the equivalent for non-Siemens backends).
 */
const PIR_TO_CANONICAL = {
    bool: 'Bool',
    int: 'Int',
    dint: 'DInt',
    real: 'Real',
};
function canonicalType(t) {
    return PIR_TO_CANONICAL[t] ?? 'Variant';
}
function ioRow(io) {
    return {
        name: io.id,
        dataType: canonicalType(io.data_type),
        ioAddress: io.address,
        comment: io.description ?? io.name,
        source: 'io',
    };
}
function parameterRow(p) {
    const unitSuffix = p.unit ? ` [${p.unit}]` : '';
    return {
        name: p.id,
        dataType: canonicalType(p.data_type),
        comment: p.description ?? `${p.name}${unitSuffix}`,
        source: 'parameter',
    };
}
function stationStateRow(s) {
    return {
        name: `${s.id}_state`,
        dataType: 'Int',
        comment: `Sequence state index of station ${s.name}`,
        source: 'station_state',
    };
}
function sortById(arr) {
    return arr.slice().sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * Build the canonical tag tables for a project. Currently produces a single
 * `Tags_Main` table aggregating I/O, parameters and station state words.
 * Future kinds (`io`, `internal`, `alarms`) can be added without breaking
 * the IR shape.
 */
export function buildTagTablesIR(project) {
    const machine = project.machines[0];
    const rows = [];
    const seen = new Set();
    const push = (row) => {
        if (seen.has(row.name))
            return;
        seen.add(row.name);
        rows.push(row);
    };
    for (const io of sortById(machine.io))
        push(ioRow(io));
    for (const p of sortById(machine.parameters))
        push(parameterRow(p));
    // Alarms intentionally omitted — they belong to DB_Alarms.
    // Reference type to keep tsc strict happy if extended later.
    void null;
    for (const s of sortById(machine.stations))
        push(stationStateRow(s));
    return [{ name: 'Tags_Main', kind: 'main', rows }];
}

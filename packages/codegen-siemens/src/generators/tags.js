import { buildTagTablesIR, } from '@plccopilot/codegen-core';
import { TAGS_CSV_PATH } from '../naming.js';
import { buildCsv } from '../utils/csv.js';
const HEADER = ['Name', 'DataType', 'Address', 'Comment'];
const CANONICAL_TO_SCL = {
    Bool: 'Bool',
    Int: 'Int',
    DInt: 'DInt',
    Real: 'Real',
};
function sclDataType(canonical) {
    return CANONICAL_TO_SCL[canonical] ?? canonical;
}
/**
 * Siemens %I/%Q absolute address rendering. Pure: takes a structured PIR
 * address + the IR-canonical data type and returns the SCL-style address
 * string. Empty address fields (DB-area, missing address) collapse to ''.
 */
function renderSiemensAddress(address, canonicalType) {
    if (!address)
        return '';
    if (address.memory_area === 'DB')
        return '';
    const area = address.memory_area;
    if (canonicalType === 'Bool') {
        const bit = address.bit ?? 0;
        return `%${area}${address.byte}.${bit}`;
    }
    if (canonicalType === 'Int')
        return `%${area}W${address.byte}`;
    if (canonicalType === 'DInt' || canonicalType === 'Real')
        return `%${area}D${address.byte}`;
    return `%${area}${address.byte}`;
}
function rowToCsv(row) {
    return [
        row.name,
        sclDataType(row.dataType),
        renderSiemensAddress(row.ioAddress, row.dataType),
        row.comment ?? '',
    ];
}
/**
 * Render the Siemens-side `Tags_Main.csv` artifact from a tag table IR.
 * Address formatting is Siemens-specific (`%I0.0` etc.); the IR-side rows
 * stay backend-neutral.
 */
export function renderTagsCsv(tagTable) {
    return {
        path: TAGS_CSV_PATH,
        kind: 'csv',
        content: buildCsv(HEADER, tagTable.rows.map(rowToCsv)),
    };
}
/**
 * Backwards-compatible façade. Consumers that import `generateTagsTable`
 * from `@plccopilot/codegen-siemens` keep their (project)-shaped signature.
 * Internally we build the neutral tag rows in core and render Siemens CSV.
 */
export function generateTagsTable(project) {
    const [main] = buildTagTablesIR(project);
    if (!main) {
        return { path: TAGS_CSV_PATH, kind: 'csv', content: buildCsv(HEADER, []) };
    }
    return renderTagsCsv(main);
}

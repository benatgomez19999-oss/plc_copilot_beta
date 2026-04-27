import { ROCKWELL_DIR } from '../naming.js';
const PIR_TO_IEC = {
    Bool: 'BOOL',
    Int: 'INT',
    DInt: 'DINT',
    Real: 'REAL',
};
const PAD = '    ';
function iecType(canonicalType) {
    return PIR_TO_IEC[canonicalType] ?? canonicalType.toUpperCase();
}
/**
 * Rockwell UDT POC. The `TYPE … END_TYPE` envelope is IEC-style because
 * Studio 5000 has no standalone UDT-as-text import; users recreate the
 * structure manually or via L5X. This artifact validates the IR shape —
 * not a drop-in import.
 */
export function renderTypeArtifactRockwell(t) {
    const lines = [];
    lines.push(`(* Rockwell UDT POC: ${t.name} *)`);
    lines.push(`(* Studio 5000 import requires manual UDT re-creation. *)`);
    lines.push('');
    lines.push(`TYPE ${t.name} :`);
    lines.push(`STRUCT`);
    for (const f of t.fields) {
        const c = f.comment ? ` // ${f.comment}` : '';
        lines.push(`${PAD}${f.name} : ${iecType(f.dataType)};${c}`);
    }
    lines.push(`END_STRUCT`);
    lines.push(`END_TYPE`);
    lines.push('');
    return {
        path: `${ROCKWELL_DIR}/${t.name}.st`,
        content: lines.join('\n'),
    };
}

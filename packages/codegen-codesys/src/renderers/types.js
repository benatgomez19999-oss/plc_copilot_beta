import { codesysTypeName } from '@plccopilot/codegen-core';
import { CODESYS_DIR } from '../naming.js';
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
export function renderTypeArtifactCodesys(t) {
    const dutName = codesysTypeName(t.name);
    const lines = [];
    lines.push(`TYPE ${dutName} :`);
    lines.push(`STRUCT`);
    for (const f of t.fields) {
        const c = f.comment ? ` (* ${f.comment} *)` : '';
        lines.push(`${PAD}${f.name} : ${iecType(f.dataType)};${c}`);
    }
    lines.push(`END_STRUCT`);
    lines.push(`END_TYPE`);
    lines.push('');
    return {
        path: `${CODESYS_DIR}/${dutName}.st`,
        content: lines.join('\n'),
    };
}

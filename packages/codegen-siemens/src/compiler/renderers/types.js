import { SIEMENS_DIR } from '../../naming.js';
const PAD = '    ';
// ---------- Siemens UDT ----------
export function renderTypeArtifactSiemens(t) {
    const lines = [];
    lines.push(`TYPE "${t.name}"`);
    lines.push(`VERSION : 0.1`);
    lines.push(`STRUCT`);
    for (const f of t.fields) {
        const c = f.comment ? `  // ${f.comment}` : '';
        lines.push(`${PAD}${f.name} : ${f.dataType};${c}`);
    }
    lines.push(`END_STRUCT;`);
    lines.push(`END_TYPE`);
    lines.push('');
    return {
        path: `${SIEMENS_DIR}/${t.name}.scl`,
        content: lines.join('\n'),
    };
}

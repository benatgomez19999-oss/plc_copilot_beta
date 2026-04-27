import type {
  DataBlockArtifactIR,
  DataFieldIR,
} from '@plccopilot/codegen-core';
import { SIEMENS_DIR } from '../../naming.js';

const PAD = '    ';

export function renderDataBlockSiemens(db: DataBlockArtifactIR): {
  path: string;
  content: string;
} {
  const lines: string[] = [];
  lines.push(`DATA_BLOCK "${db.name}"`);
  lines.push(`{ S7_Optimized_Access := 'TRUE' }`);
  lines.push(`VERSION : 0.1`);
  lines.push(`NON_RETAIN`);
  lines.push('');
  lines.push('VAR');
  let firstFieldEmitted = false;
  for (const f of db.fields) {
    if (f.preComment) {
      if (firstFieldEmitted) lines.push('');
      lines.push(`${PAD}// ${f.preComment}`);
    }
    lines.push(siemensFieldLine(f));
    firstFieldEmitted = true;
  }
  lines.push('END_VAR');
  lines.push('');
  if (hasInitialValues(db)) {
    lines.push('BEGIN');
    for (const f of db.fields) {
      if (f.initialValue !== undefined) {
        lines.push(`${PAD}${f.name} := ${f.initialValue};`);
      }
    }
    lines.push('END_DATA_BLOCK');
  } else {
    lines.push('BEGIN');
    lines.push('END_DATA_BLOCK');
  }
  lines.push('');

  return {
    path: `${SIEMENS_DIR}/${db.name}.scl`,
    content: lines.join('\n'),
  };
}

function siemensFieldLine(f: DataFieldIR): string {
  const c = f.comment ? `  // ${f.comment}` : '';
  return `${PAD}${f.name} : ${f.dataType};${c}`;
}

function hasInitialValues(db: DataBlockArtifactIR): boolean {
  return db.fields.some((f) => f.initialValue !== undefined);
}

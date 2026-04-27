const PIR_TO_VALUE = {
    bool: 'bool',
    int: 'int',
    dint: 'int',
    real: 'real',
};
export function pirToValueType(pirDataType) {
    return PIR_TO_VALUE[pirDataType] ?? 'unknown';
}
const VALUE_TO_SCL = {
    bool: 'BOOL',
    int: 'INT',
    real: 'REAL',
    string: 'STRING',
    unknown: 'VARIANT',
};
export function valueTypeToScl(v) {
    return VALUE_TO_SCL[v];
}

export function stableJson(value) {
    return JSON.stringify(value, null, 2) + '\n';
}

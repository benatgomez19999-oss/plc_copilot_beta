const UNIT = '    ';
export function indentLines(lines, level) {
    const pad = UNIT.repeat(level);
    return lines.map((l) => (l.length === 0 ? l : pad + l));
}
export function pad(line, level) {
    if (line.length === 0)
        return line;
    return UNIT.repeat(level) + line;
}
export function joinLines(...parts) {
    const out = [];
    for (const p of parts) {
        if (Array.isArray(p))
            out.push(...p);
        else
            out.push(p);
    }
    return out.join('\n');
}

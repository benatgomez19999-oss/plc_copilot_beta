const UNIT = '    ';

export function indentLines(lines: readonly string[], level: number): string[] {
  const pad = UNIT.repeat(level);
  return lines.map((l) => (l.length === 0 ? l : pad + l));
}

export function pad(line: string, level: number): string {
  if (line.length === 0) return line;
  return UNIT.repeat(level) + line;
}

export function joinLines(...parts: (string | readonly string[])[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (Array.isArray(p)) out.push(...(p as readonly string[]));
    else out.push(p as string);
  }
  return out.join('\n');
}

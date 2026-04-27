import { pad } from '../utils/indent.js';
import { alarmSymbol, localSymbol } from './symbols.js';
export function renderTimerDecls(timers) {
    if (timers.length === 0)
        return [];
    const lines = [pad(`// --- Transition timeouts (TON) ---`, 1)];
    for (const t of timers) {
        lines.push(pad(`${t.varName} : TON;  // alarm: ${t.alarmId} (${t.ms} ms${t.isWildcard ? ', wildcard' : ''})`, 1));
    }
    return lines;
}
export function renderTimerBlock(timers) {
    if (timers.length === 0)
        return [];
    const lines = [
        pad(`// --- Transition timeouts (tick while in source state; raise alarm on expiry) ---`, 1),
    ];
    for (const t of timers) {
        const inExpr = t.isWildcard ? 'TRUE' : `(#state = ${t.srcStateIdx})`;
        lines.push(pad(`${localSymbol(t.varName)}(IN := ${inExpr}, PT := T#${t.ms}MS);`, 1));
        lines.push(pad(`IF ${localSymbol(t.varName)}.Q THEN`, 1));
        lines.push(pad(`${alarmSymbol(t.alarmId)} := TRUE;   // alarm from transition "${t.transitionId}"`, 2));
        lines.push(pad(`END_IF;`, 1));
    }
    lines.push('');
    return lines;
}

import { sanitizeSymbol } from '../../naming.js';
import { diag } from '../diagnostics.js';
/**
 * Collects edge-trigger instances discovered while lowering expressions.
 * Dedupes by instance name within a single station. Cross-station uniqueness
 * is guaranteed by the `stationId` prefix.
 *
 * Registers an `EDGE_INSTANCE_COLLISION` diagnostic when two different PIR
 * sources sanitise to the same instance name inside the same station.
 */
export class EdgeRegistry {
    stationId;
    map = new Map();
    diagnostics = [];
    constructor(stationId = '') {
        this.stationId = stationId;
    }
    register(inst) {
        const existing = this.map.get(inst.instanceName);
        if (!existing) {
            this.map.set(inst.instanceName, inst);
            return;
        }
        if (existing.sourceArgText !== inst.sourceArgText) {
            this.diagnostics.push(diag('error', 'EDGE_INSTANCE_COLLISION', `edge instance "${inst.instanceName}" collides on two PIR sources: "${existing.sourceArgText}" vs "${inst.sourceArgText}"`, {
                stationId: this.stationId || undefined,
                symbol: inst.instanceName,
                hint: 'rename one of the edge arguments or add an explicit station scope',
            }));
        }
    }
    has(instanceName) {
        return this.map.has(instanceName);
    }
    size() {
        return this.map.size;
    }
    all() {
        return Array.from(this.map.values()).sort((a, b) => a.instanceName.localeCompare(b.instanceName));
    }
    collectedDiagnostics() {
        return this.diagnostics.slice();
    }
}
/**
 * Deterministic instance name for an edge-trigger. Includes the PIR station
 * id as a sanitised prefix to avoid cross-station collisions.
 *
 *   rising(io_part_sensor)   in st_load → R_TRIG_st_load_io_part_sensor
 *   falling(cyl01.retracted) in st_load → F_TRIG_st_load_cyl01_retracted
 *
 * `edge(x)` is lowered as R_TRIG in v0.1 (an info diagnostic is emitted at
 * the call site).
 */
export function edgeInstanceName(kind, argText, stationId = '') {
    const stationTag = stationId ? `${sanitizeSymbol(stationId)}_` : '';
    const argTag = sanitizeSymbol(argText);
    const base = `${stationTag}${argTag}`;
    if (kind === 'falling') {
        return { instanceName: `F_TRIG_${base}`, triggerType: 'F_TRIG' };
    }
    return { instanceName: `R_TRIG_${base}`, triggerType: 'R_TRIG' };
}
export function buildEdgeVarDecls(registry) {
    const edges = registry.all();
    if (edges.length === 0)
        return [];
    return edges.map((e, idx) => ({
        name: e.instanceName,
        type: e.triggerType,
        preComment: idx === 0 ? '--- Edge-trigger instances ---' : undefined,
    }));
}
export function lowerEdgeTickBlock(registry) {
    const edges = registry.all();
    if (edges.length === 0)
        return [];
    const out = [
        { kind: 'Comment', text: '--- Edge-trigger updates ---' },
    ];
    for (const e of edges) {
        out.push({
            kind: 'FbCall',
            instance: { kind: 'fbInstance', name: e.instanceName },
            params: [{ name: 'CLK', value: e.sourceSclExpr }],
        });
    }
    return out;
}

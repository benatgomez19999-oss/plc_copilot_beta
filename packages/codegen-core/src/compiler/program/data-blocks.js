import { CodegenError } from '../../types.js';
function alarmText(al) {
    const en = al.text_i18n.en;
    if (en)
        return en;
    const keys = Object.keys(al.text_i18n);
    if (keys.length > 0) {
        const first = al.text_i18n[keys[0]];
        if (first)
            return first;
    }
    return al.id;
}
function sanitizeComment(s) {
    return s.replace(/[\r\n\t]+/g, ' ').trim();
}
const PIR_TO_SIEMENS = {
    bool: 'Bool',
    int: 'Int',
    dint: 'DInt',
    real: 'Real',
};
function siemensType(pirDataType) {
    return PIR_TO_SIEMENS[pirDataType] ?? 'Variant';
}
// ---------- DB_Alarms (v2: ack_all + set_/active_) ----------
export function buildDbAlarmsIR(project) {
    const machine = project.machines[0];
    if (machine.alarms.length === 0)
        return null;
    const sorted = machine.alarms
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
    const fields = [];
    fields.push({
        name: 'ack_all',
        dataType: 'Bool',
        preComment: '--- Global ack (HMI / command channel) ---',
    });
    for (const al of sorted) {
        const cmt = sanitizeComment(`[${al.severity}] ${alarmText(al)}`);
        fields.push({
            name: `set_${al.id}`,
            dataType: 'Bool',
            comment: cmt,
            preComment: al === sorted[0]
                ? '--- Per-alarm set / active pairs ---'
                : undefined,
        });
        fields.push({
            name: `active_${al.id}`,
            dataType: 'Bool',
            comment: 'latched by FB_Alarms',
        });
    }
    return {
        name: 'DB_Alarms',
        dbKind: 'alarms',
        fields,
    };
}
// ---------- DB_Global_Params ----------
function paramComment(p) {
    if (p.description)
        return sanitizeComment(p.description);
    const unit = p.unit ? ` [${p.unit}]` : '';
    return sanitizeComment(`${p.name}${unit}`);
}
function renderInitParam(p) {
    if (typeof p.default === 'boolean')
        return p.default ? 'TRUE' : 'FALSE';
    if (p.data_type === 'real') {
        const s = String(p.default);
        return /[.eE]/.test(s) ? s : `${s}.0`;
    }
    return String(p.default);
}
export function buildDbParamsIR(project) {
    const machine = project.machines[0];
    if (machine.parameters.length === 0)
        return null;
    const sorted = machine.parameters
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
    const fields = sorted.map((p) => ({
        name: p.id,
        dataType: siemensType(p.data_type),
        initialValue: renderInitParam(p),
        comment: paramComment(p),
    }));
    return {
        name: 'DB_Global_Params',
        dbKind: 'params',
        fields,
    };
}
// ---------- DB_Recipes (flattened) ----------
function renderInitRecipe(p, value) {
    if (typeof value === 'boolean')
        return value ? 'TRUE' : 'FALSE';
    if (p.data_type === 'real') {
        const s = String(value);
        return /[.eE]/.test(s) ? s : `${s}.0`;
    }
    return String(value);
}
export function buildDbRecipesIR(project) {
    const machine = project.machines[0];
    if (machine.recipes.length === 0)
        return null;
    const paramsById = new Map(machine.parameters.map((p) => [p.id, p]));
    const fields = [];
    const recipes = machine.recipes
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
    for (const r of recipes) {
        for (const paramId of Object.keys(r.values).sort()) {
            const p = paramsById.get(paramId);
            if (!p) {
                // Sprint 38 — fail-fast (industrial correctness): silently
                // dropping the field would emit a DB that does not include
                // the operator's intended setpoint.
                // Sprint 39 — enrich the throw with structured metadata so
                // CLI / Web banner can render path + symbol + hint without
                // string-parsing the message.
                const recipeIndex = machine.recipes.findIndex((x) => x.id === r.id);
                const path = recipeIndex >= 0
                    ? `machines[0].recipes[${recipeIndex}].values.${paramId}`
                    : `machines[0].recipes[?].values.${paramId}`;
                throw new CodegenError('UNKNOWN_PARAMETER', `Recipe "${r.id}" references unknown parameter "${paramId}".`, {
                    path,
                    symbol: paramId,
                    hint: 'Define the parameter in machine.parameters or remove it from the recipe.',
                });
            }
            fields.push({
                name: `${r.id}_${paramId}`,
                dataType: siemensType(p.data_type),
                initialValue: renderInitRecipe(p, r.values[paramId]),
                comment: sanitizeComment(`${r.name} / ${paramId}`),
            });
        }
    }
    if (fields.length === 0)
        return null;
    return {
        name: 'DB_Recipes',
        dbKind: 'recipes',
        fields,
    };
}

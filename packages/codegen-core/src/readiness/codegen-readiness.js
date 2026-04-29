// Sprint 86 — Codegen readiness / preflight diagnostics v0.
// Runtime mirror of `codegen-readiness.ts`. The codegen-core
// package keeps source-tree .js artifacts alongside .ts to make
// vite/vitest workspace consumers see the new exports without a
// rebuild step. Public contract documented in the .ts file.
import { dedupDiagnostics, diag, sortDiagnostics, } from '../compiler/diagnostics.js';
import { equipmentPath, equipmentTypePath, stationPath, } from '../compiler/diagnostic-paths.js';

const CORE_SUPPORTED_EQUIPMENT = new Set([
    'pneumatic_cylinder_2pos',
    'motor_simple',
    'sensor_discrete',
]);
const CORE_SUPPORTED_DATA_TYPES = new Set([
    'bool',
    'int',
    'dint',
    'real',
]);
const CORE_SUPPORTED_MEMORY_AREAS = new Set([
    'I',
    'Q',
    'M',
    'DB',
]);

const TARGET_CAPABILITIES = {
    core: {
        target: 'core',
        supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
        supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
        supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
    },
    siemens: {
        target: 'siemens',
        supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
        supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
        supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
    },
    codesys: {
        target: 'codesys',
        supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
        supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
        supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
    },
    rockwell: {
        target: 'rockwell',
        supportedEquipmentTypes: CORE_SUPPORTED_EQUIPMENT,
        supportedIoDataTypes: CORE_SUPPORTED_DATA_TYPES,
        supportedIoMemoryAreas: CORE_SUPPORTED_MEMORY_AREAS,
    },
};

export function getTargetCapabilities(target) {
    return TARGET_CAPABILITIES[target];
}

export function preflightProject(project, options = {}) {
    const target = options.target ?? 'core';
    const capabilities = options.capabilities ?? TARGET_CAPABILITIES[target];
    const diagnostics = [];

    if (!project || typeof project !== 'object') {
        diagnostics.push(diag('error', 'READINESS_PIR_EMPTY', 'PIR project is missing.', {
            path: '',
            hint: 'Pass a non-null PIR Project before invoking codegen.',
        }));
        return finaliseResult(target, diagnostics);
    }

    const machines = Array.isArray(project.machines) ? project.machines : [];
    if (machines.length === 0) {
        diagnostics.push(diag('error', 'READINESS_PIR_EMPTY', 'PIR project has no machines.', {
            path: 'machines',
            hint: 'Add at least one machine to the PIR project before invoking codegen.',
        }));
        return finaliseResult(target, diagnostics);
    }

    for (let mi = 0; mi < machines.length; mi++) {
        const machine = machines[mi];
        if (!machine) continue;
        walkMachine(machine, mi, capabilities, diagnostics);
    }
    return finaliseResult(target, diagnostics);
}

function finaliseResult(target, diagnostics) {
    const sorted = sortDiagnostics(dedupDiagnostics(diagnostics));
    const hasBlockingErrors = sorted.some((d) => d.severity === 'error');
    return { target, diagnostics: sorted, hasBlockingErrors };
}

function walkMachine(machine, machineIndex, capabilities, out) {
    const equipmentByMachine = new Map();
    const ioByAddress = new Map();
    const ioById = new Map();
    const generatedSymbolByMachine = new Map();

    const ioList = Array.isArray(machine.io) ? machine.io : [];
    if (ioList.length === 0) {
        out.push(diag('info', 'READINESS_NO_GENERATABLE_OBJECTS',
            `Machine ${JSON.stringify(machine.id)} has no IO signals; codegen will produce no IO tables.`,
            { path: `machines[${machineIndex}].io` }));
    }
    for (const io of ioList) {
        if (!io || typeof io !== 'object') continue;
        pushMapList(ioById, io.id, io);
        const addr = ioAddressKey(io);
        if (addr.length > 0) pushMapList(ioByAddress, addr, io);

        if (typeof io.data_type === 'string' && !capabilities.supportedIoDataTypes.has(io.data_type)) {
            out.push(diag('error', 'READINESS_UNSUPPORTED_IO_DATA_TYPE',
                `IO ${JSON.stringify(io.id)} has data_type ${JSON.stringify(io.data_type)}, ` +
                `which target ${capabilities.target} does not support today.`,
                {
                    path: `machines[${machineIndex}].io[*]`,
                    symbol: io.id,
                    hint: `Supported data types for ${capabilities.target}: ${formatSet(capabilities.supportedIoDataTypes)}.`,
                }));
        }
        const area = io.address?.memory_area;
        if (typeof area === 'string' && !capabilities.supportedIoMemoryAreas.has(area)) {
            out.push(diag('error', 'READINESS_UNSUPPORTED_IO_MEMORY_AREA',
                `IO ${JSON.stringify(io.id)} uses memory area ${JSON.stringify(area)}, ` +
                `which target ${capabilities.target} does not support today.`,
                {
                    path: `machines[${machineIndex}].io[*]`,
                    symbol: io.id,
                    hint: `Supported memory areas for ${capabilities.target}: ${formatSet(capabilities.supportedIoMemoryAreas)}.`,
                }));
        }
    }
    for (const [id, group] of ioById) {
        if (group.length > 1) {
            out.push(diag('warning', 'READINESS_DUPLICATE_IO_ID',
                `Machine ${JSON.stringify(machine.id)} has ${group.length} IO signals sharing id ${JSON.stringify(id)}; ` +
                `codegen will emit conflicting tag rows.`,
                { path: `machines[${machineIndex}].io[*]`, symbol: id }));
        }
    }
    for (const [key, group] of ioByAddress) {
        if (group.length > 1) {
            out.push(diag('warning', 'READINESS_DUPLICATE_IO_ADDRESS',
                `Machine ${JSON.stringify(machine.id)} has ${group.length} IO signals at the same address ` +
                `(${key}); codegen will not silently merge them.`,
                { path: `machines[${machineIndex}].io[*]`, symbol: group[0].id }));
        }
    }

    const stations = Array.isArray(machine.stations) ? machine.stations : [];
    if (stations.length === 0) {
        out.push(diag('info', 'READINESS_NO_GENERATABLE_OBJECTS',
            `Machine ${JSON.stringify(machine.id)} has no stations; codegen will produce no station FBs.`,
            { path: `machines[${machineIndex}].stations` }));
    }
    for (let si = 0; si < stations.length; si++) {
        const station = stations[si];
        if (!station) continue;
        walkStation(station, machineIndex, si, capabilities, equipmentByMachine, generatedSymbolByMachine, out);
    }

    for (const [id, group] of equipmentByMachine) {
        if (group.length > 1) {
            out.push(diag('warning', 'READINESS_DUPLICATE_EQUIPMENT_ID',
                `Machine ${JSON.stringify(machine.id)} has ${group.length} equipment instances sharing id ${JSON.stringify(id)}.`,
                { path: `machines[${machineIndex}].stations[*].equipment[*]`, symbol: id }));
        }
    }
    for (const [symbolKey, group] of generatedSymbolByMachine) {
        const distinctIds = new Set(group.map((eq) => eq.id));
        if (distinctIds.size > 1) {
            out.push(diag('warning', 'READINESS_DUPLICATE_GENERATED_SYMBOL',
                `Machine ${JSON.stringify(machine.id)} has ${distinctIds.size} distinct equipment ids ` +
                `that all render to symbol ${JSON.stringify(symbolKey)}; codegen will collide.`,
                { path: `machines[${machineIndex}].stations[*].equipment[*]`, symbol: symbolKey }));
        }
    }
}

function walkStation(station, machineIndex, stationIndex, capabilities, equipmentByMachine, generatedSymbolByMachine, out) {
    const equipment = Array.isArray(station.equipment) ? station.equipment : [];
    if (equipment.length === 0) {
        out.push(diag('info', 'READINESS_NO_GENERATABLE_OBJECTS',
            `Station ${JSON.stringify(station.id)} has no equipment; codegen will produce no station FB body.`,
            { path: stationPath(machineIndex, stationIndex), stationId: station.id }));
    }
    for (let ei = 0; ei < equipment.length; ei++) {
        const eq = equipment[ei];
        if (!eq) continue;
        pushMapList(equipmentByMachine, eq.id, eq);
        if (typeof eq.code_symbol === 'string' && eq.code_symbol.length > 0) {
            pushMapList(generatedSymbolByMachine, eq.code_symbol, eq);
        }
        if (!capabilities.supportedEquipmentTypes.has(eq.type)) {
            out.push(diag('error', 'READINESS_UNSUPPORTED_EQUIPMENT_FOR_TARGET',
                `Equipment ${JSON.stringify(eq.id)} has type ${JSON.stringify(eq.type)}, ` +
                `which target ${capabilities.target} does not support today.`,
                {
                    path: equipmentTypePath(machineIndex, stationIndex, ei),
                    stationId: station.id,
                    symbol: eq.id,
                    hint: `Supported equipment kinds for ${capabilities.target}: ` +
                        `${formatSet(capabilities.supportedEquipmentTypes)}. ` +
                        `Either change ${eq.id}.type or skip this equipment via review.`,
                }));
        }
    }

    const seq = station.sequence;
    if (seq && Array.isArray(seq.states) && Array.isArray(seq.transitions)) {
        const states = seq.states;
        const transitions = seq.transitions;
        if (states.length <= 2 && transitions.length <= 1 &&
            states.some((s) => s?.id === 'init') &&
            states.some((s) => s?.id === 'terminal')) {
            out.push(diag('info', 'READINESS_PLACEHOLDER_SEQUENCE',
                `Station ${JSON.stringify(station.id)} carries the Sprint 76 placeholder sequence ` +
                `(init → terminal); codegen will emit a no-op state machine.`,
                { path: `${stationPath(machineIndex, stationIndex)}.sequence`, stationId: station.id }));
        }
    }
}

function ioAddressKey(io) {
    const a = io.address;
    if (!a || typeof a !== 'object') return '';
    const parts = [];
    if (typeof a.memory_area === 'string') parts.push(`area=${a.memory_area}`);
    if (typeof a.byte === 'number') parts.push(`byte=${a.byte}`);
    if (typeof a.bit === 'number') parts.push(`bit=${a.bit}`);
    if (typeof a.db_number === 'number') parts.push(`db=${a.db_number}`);
    return parts.join('|');
}
function pushMapList(map, key, value) {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
}
function formatSet(set) {
    return Array.from(set).sort().map((s) => JSON.stringify(s)).join(', ');
}

export { equipmentPath, equipmentTypePath, stationPath };

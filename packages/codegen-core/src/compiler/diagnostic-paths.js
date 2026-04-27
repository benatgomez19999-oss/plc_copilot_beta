/**
 * Sprint 40 — pure helpers that build the canonical, bracket-indexed
 * PIR JSON paths surfaced in `CodegenError.path` and `Diagnostic.path`.
 * Centralising the formatting prevents drift between throw sites
 * (every caller producing slightly different prose like
 * `machines/0/stations/2/...`) and makes the path string a real
 * jump-target for the web's `findJsonPathLine` helper.
 *
 * Style is fixed: `machines[i].stations[j].equipment[k]…`. Everything
 * is dot-separated; array indices use square brackets. Recipe value
 * keys appear as `…recipes[k].values.<paramId>` rather than
 * `values["<paramId>"]` because PIR ids are always identifier-safe
 * (lowercase + underscore).
 *
 * The functions are deliberately thin so tests + producers can read
 * them at a glance — no validation, no defensive checks: the indices
 * are produced by callers that already iterate the project, so the
 * inputs are always non-negative integers in range.
 */
const M = (i) => `machines[${i}]`;
export function machinePath(machineIndex = 0) {
    return M(machineIndex);
}
export function stationPath(machineIndex, stationIndex) {
    return `${M(machineIndex)}.stations[${stationIndex}]`;
}
export function equipmentPath(machineIndex, stationIndex, equipmentIndex) {
    return `${stationPath(machineIndex, stationIndex)}.equipment[${equipmentIndex}]`;
}
export function equipmentTypePath(machineIndex, stationIndex, equipmentIndex) {
    return `${equipmentPath(machineIndex, stationIndex, equipmentIndex)}.type`;
}
export function transitionPath(machineIndex, stationIndex, transitionIndex) {
    return `${stationPath(machineIndex, stationIndex)}.sequence.transitions[${transitionIndex}]`;
}
export function interlockPath(machineIndex, interlockIndex) {
    return `${M(machineIndex)}.interlocks[${interlockIndex}]`;
}
export function parameterPath(machineIndex, parameterIndex) {
    return `${M(machineIndex)}.parameters[${parameterIndex}]`;
}
export function recipePath(machineIndex, recipeIndex) {
    return `${M(machineIndex)}.recipes[${recipeIndex}]`;
}
export function recipeValuePath(machineIndex, recipeIndex, paramId) {
    return `${recipePath(machineIndex, recipeIndex)}.values.${paramId}`;
}
export function ioPath(machineIndex, ioIndex) {
    return `${M(machineIndex)}.io[${ioIndex}]`;
}
// =============================================================================
// Sprint 41 — additional helpers for the lowering layer
// =============================================================================
export function statePath(machineIndex, stationIndex, stateIndex) {
    return `${stationPath(machineIndex, stationIndex)}.sequence.states[${stateIndex}]`;
}
export function stateActivityActivatePath(machineIndex, stationIndex, stateIndex, activateIndex) {
    return `${statePath(machineIndex, stationIndex, stateIndex)}.activity.activate[${activateIndex}]`;
}
export function statesPath(machineIndex, stationIndex) {
    return `${stationPath(machineIndex, stationIndex)}.sequence.states`;
}
export function transitionFromPath(machineIndex, stationIndex, transitionIndex) {
    return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.from`;
}
export function transitionToPath(machineIndex, stationIndex, transitionIndex) {
    return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.to`;
}
export function transitionGuardPath(machineIndex, stationIndex, transitionIndex) {
    return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.guard`;
}
export function transitionTimeoutPath(machineIndex, stationIndex, transitionIndex) {
    return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.timeout`;
}
export function transitionTimeoutMsPath(machineIndex, stationIndex, transitionIndex) {
    return `${transitionTimeoutPath(machineIndex, stationIndex, transitionIndex)}.ms`;
}
export function transitionTimeoutAlarmPath(machineIndex, stationIndex, transitionIndex) {
    return `${transitionTimeoutPath(machineIndex, stationIndex, transitionIndex)}.alarm_id`;
}
export function transitionsPath(machineIndex, stationIndex) {
    return `${stationPath(machineIndex, stationIndex)}.sequence.transitions`;
}
export function stationEquipmentPath(machineIndex, stationIndex) {
    return `${stationPath(machineIndex, stationIndex)}.equipment`;
}
export function equipmentIoBindingsPath(machineIndex, stationIndex, equipmentIndex) {
    return `${equipmentPath(machineIndex, stationIndex, equipmentIndex)}.io_bindings`;
}
export function machineInterlocksPath(machineIndex) {
    return `${M(machineIndex)}.interlocks`;
}
export function machineIoPath(machineIndex) {
    return `${M(machineIndex)}.io`;
}
export function machineAlarmsPath(machineIndex) {
    return `${M(machineIndex)}.alarms`;
}
export function alarmPath(machineIndex, alarmIndex) {
    return `${M(machineIndex)}.alarms[${alarmIndex}]`;
}
export function alarmWhenPath(machineIndex, alarmIndex) {
    return `${alarmPath(machineIndex, alarmIndex)}.when`;
}
export function parametersPath(machineIndex) {
    return `${M(machineIndex)}.parameters`;
}
export function recipesPath(machineIndex) {
    return `${M(machineIndex)}.recipes`;
}
export function recipeValuesPath(machineIndex, recipeIndex) {
    return `${recipePath(machineIndex, recipeIndex)}.values`;
}
export function interlockInhibitsPath(machineIndex, interlockIndex) {
    return `${interlockPath(machineIndex, interlockIndex)}.inhibits`;
}
export function interlockWhenPath(machineIndex, interlockIndex) {
    return `${interlockPath(machineIndex, interlockIndex)}.when`;
}
export function equipmentIoBindingPath(machineIndex, stationIndex, equipmentIndex, role) {
    return `${equipmentPath(machineIndex, stationIndex, equipmentIndex)}.io_bindings.${role}`;
}

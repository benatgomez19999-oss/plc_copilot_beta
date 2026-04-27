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

const M = (i: number): string => `machines[${i}]`;

export function machinePath(machineIndex = 0): string {
  return M(machineIndex);
}

export function stationPath(
  machineIndex: number,
  stationIndex: number,
): string {
  return `${M(machineIndex)}.stations[${stationIndex}]`;
}

export function equipmentPath(
  machineIndex: number,
  stationIndex: number,
  equipmentIndex: number,
): string {
  return `${stationPath(machineIndex, stationIndex)}.equipment[${equipmentIndex}]`;
}

export function equipmentTypePath(
  machineIndex: number,
  stationIndex: number,
  equipmentIndex: number,
): string {
  return `${equipmentPath(machineIndex, stationIndex, equipmentIndex)}.type`;
}

export function transitionPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${stationPath(machineIndex, stationIndex)}.sequence.transitions[${transitionIndex}]`;
}

export function interlockPath(
  machineIndex: number,
  interlockIndex: number,
): string {
  return `${M(machineIndex)}.interlocks[${interlockIndex}]`;
}

export function parameterPath(
  machineIndex: number,
  parameterIndex: number,
): string {
  return `${M(machineIndex)}.parameters[${parameterIndex}]`;
}

export function recipePath(
  machineIndex: number,
  recipeIndex: number,
): string {
  return `${M(machineIndex)}.recipes[${recipeIndex}]`;
}

export function recipeValuePath(
  machineIndex: number,
  recipeIndex: number,
  paramId: string,
): string {
  return `${recipePath(machineIndex, recipeIndex)}.values.${paramId}`;
}

export function ioPath(machineIndex: number, ioIndex: number): string {
  return `${M(machineIndex)}.io[${ioIndex}]`;
}

// =============================================================================
// Sprint 41 — additional helpers for the lowering layer
// =============================================================================

export function statePath(
  machineIndex: number,
  stationIndex: number,
  stateIndex: number,
): string {
  return `${stationPath(machineIndex, stationIndex)}.sequence.states[${stateIndex}]`;
}

export function stateActivityActivatePath(
  machineIndex: number,
  stationIndex: number,
  stateIndex: number,
  activateIndex: number,
): string {
  return `${statePath(machineIndex, stationIndex, stateIndex)}.activity.activate[${activateIndex}]`;
}

export function statesPath(
  machineIndex: number,
  stationIndex: number,
): string {
  return `${stationPath(machineIndex, stationIndex)}.sequence.states`;
}

export function transitionFromPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.from`;
}

export function transitionToPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.to`;
}

export function transitionGuardPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.guard`;
}

export function transitionTimeoutPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${transitionPath(machineIndex, stationIndex, transitionIndex)}.timeout`;
}

export function transitionTimeoutMsPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${transitionTimeoutPath(machineIndex, stationIndex, transitionIndex)}.ms`;
}

export function transitionTimeoutAlarmPath(
  machineIndex: number,
  stationIndex: number,
  transitionIndex: number,
): string {
  return `${transitionTimeoutPath(machineIndex, stationIndex, transitionIndex)}.alarm_id`;
}

export function transitionsPath(
  machineIndex: number,
  stationIndex: number,
): string {
  return `${stationPath(machineIndex, stationIndex)}.sequence.transitions`;
}

export function stationEquipmentPath(
  machineIndex: number,
  stationIndex: number,
): string {
  return `${stationPath(machineIndex, stationIndex)}.equipment`;
}

export function equipmentIoBindingsPath(
  machineIndex: number,
  stationIndex: number,
  equipmentIndex: number,
): string {
  return `${equipmentPath(machineIndex, stationIndex, equipmentIndex)}.io_bindings`;
}

export function machineInterlocksPath(machineIndex: number): string {
  return `${M(machineIndex)}.interlocks`;
}

export function machineIoPath(machineIndex: number): string {
  return `${M(machineIndex)}.io`;
}

export function machineAlarmsPath(machineIndex: number): string {
  return `${M(machineIndex)}.alarms`;
}

export function alarmPath(machineIndex: number, alarmIndex: number): string {
  return `${M(machineIndex)}.alarms[${alarmIndex}]`;
}

export function alarmWhenPath(
  machineIndex: number,
  alarmIndex: number,
): string {
  return `${alarmPath(machineIndex, alarmIndex)}.when`;
}

export function parametersPath(machineIndex: number): string {
  return `${M(machineIndex)}.parameters`;
}

export function recipesPath(machineIndex: number): string {
  return `${M(machineIndex)}.recipes`;
}

export function recipeValuesPath(
  machineIndex: number,
  recipeIndex: number,
): string {
  return `${recipePath(machineIndex, recipeIndex)}.values`;
}

export function interlockInhibitsPath(
  machineIndex: number,
  interlockIndex: number,
): string {
  return `${interlockPath(machineIndex, interlockIndex)}.inhibits`;
}

export function interlockWhenPath(
  machineIndex: number,
  interlockIndex: number,
): string {
  return `${interlockPath(machineIndex, interlockIndex)}.when`;
}

export function equipmentIoBindingPath(
  machineIndex: number,
  stationIndex: number,
  equipmentIndex: number,
  role: string,
): string {
  return `${equipmentPath(machineIndex, stationIndex, equipmentIndex)}.io_bindings.${role}`;
}

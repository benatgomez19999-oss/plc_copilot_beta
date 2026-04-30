// Sprint 74 — shared kind-alias table. Sprint 73 introduced the
// table inside csv.ts; the EPLAN-XML ingestor needs the exact same
// classifications, so the table moves here and both sources import
// it. Keeping a single source of truth means new kinds only get
// added in one place.

import type { ElectricalNodeKind } from '../types.js';

/**
 * Map of `<lowercased raw kind label>` → canonical
 * ElectricalNodeKind. Both CSV (Sprint 73) and EPLAN XML
 * (Sprint 74) ingestors run their incoming "kind" string through
 * this table. Adding new aliases here automatically benefits every
 * downstream ingestor.
 */
export const KIND_ALIASES: ReadonlyMap<string, ElectricalNodeKind> = new Map([
  // sensor / sensor-like
  ['sensor', 'sensor'],
  ['sensor_discrete', 'sensor'],
  ['proximity', 'sensor'],
  ['prox', 'sensor'],
  ['photoeye', 'sensor'],
  ['switch', 'sensor'],
  ['limit', 'sensor'],
  ['pressostat', 'sensor'],
  // valve / pneumatic
  ['valve', 'valve'],
  ['solenoid', 'valve'],
  ['pneumatic_valve', 'valve'],
  // motor / drive
  ['motor', 'motor'],
  ['drive', 'motor'],
  ['conveyor', 'motor'],
  // Sprint 88L — VFD-driven motor; the graph still classifies as
  // `motor`, but the device-row carries `raw_kind=motor_vfd_simple`
  // which `inferEquipmentRole` reads to pick the canonical
  // `motor_vfd_simple` candidate kind.
  ['motor_vfd_simple', 'motor'],
  ['vfd', 'motor'],
  // PLC + IO
  ['plc', 'plc'],
  ['cpu', 'plc'],
  ['plc_module', 'plc_module'],
  ['module', 'plc_module'],
  ['card', 'plc_module'],
  ['io_module', 'plc_module'],
  // terminals
  ['terminal', 'terminal'],
  ['terminal_strip', 'terminal_strip'],
  // safety
  ['safety', 'safety_device'],
  ['safety_device', 'safety_device'],
  ['e_stop', 'safety_device'],
  ['estop', 'safety_device'],
  ['guard_switch', 'safety_device'],
  // power
  ['power', 'power_supply'],
  ['psu', 'power_supply'],
  ['power_supply', 'power_supply'],
  // wiring infrastructure
  ['cable', 'cable'],
  ['wire', 'wire'],
  // generic actuators
  ['actuator', 'actuator'],
  ['cylinder', 'actuator'],
] as const);

/**
 * The canonical kinds we know how to recognise. Used in diagnostic
 * hints when a row/element carries an unrecognised kind value.
 */
export function knownKindHintList(): string {
  return [...new Set(KIND_ALIASES.values())].sort().join(', ');
}

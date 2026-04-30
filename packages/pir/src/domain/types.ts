export type PirVersion = '0.1.0';

export type Id = string;

export type EquipmentType =
  | 'pneumatic_cylinder_2pos'
  | 'pneumatic_cylinder_1pos'
  | 'motor_simple'
  | 'motor_vfd_simple'
  | 'valve_onoff'
  | 'sensor_discrete'
  | 'sensor_analog'
  | 'indicator_light'
  | 'supervisor';

export type EquipmentKind = 'actuator' | 'sensor' | 'indicator' | 'supervisor';

export type SignalDirection = 'in' | 'out';

export type SignalDataType = 'bool' | 'int' | 'dint' | 'real';

export type MemoryArea = 'I' | 'Q' | 'M' | 'DB';

export interface IoAddress {
  memory_area: MemoryArea;
  byte: number;
  bit?: number;
  db_number?: number;
}

export interface Provenance {
  source: 'user' | 'ai' | 'import' | 'migration';
  created_at: string;
  notes?: string;
}

export interface IoSignal {
  id: Id;
  name: string;
  direction: SignalDirection;
  data_type: SignalDataType;
  address: IoAddress;
  description?: string;
  provenance?: Provenance;
}

export interface Equipment {
  id: Id;
  name: string;
  type: EquipmentType;
  code_symbol: string;
  io_bindings: Record<string, Id>;
  // Sprint 88G — optional role → parameter id map. Each key is a
  // numeric output role declared on the equipment shape (today only
  // `speed_setpoint_out` on `motor_vfd_simple`); each value is a
  // machine-level Parameter id (machine.parameters[].id) whose
  // numeric value is wired into the bound IO at lowering time.
  // R-EQ-05 enforces existence + numeric dtype + direction match.
  io_setpoint_bindings?: Record<string, Id>;
  timing?: Record<string, number>;
  description?: string;
  provenance?: Provenance;
}

export interface Action {
  target_equipment_id: Id;
  verb: 'on' | 'off' | 'pulse' | 'set';
  pulse_ms?: number;
  value?: number | boolean;
}

export interface Activity {
  activate?: Id[];
  on_entry?: Action[];
  on_exit?: Action[];
}

export type StateKind = 'initial' | 'normal' | 'terminal';

export interface State {
  id: Id;
  name: string;
  kind: StateKind;
  activity?: Activity;
  description?: string;
}

export interface TransitionTimeout {
  ms: number;
  alarm_id: Id;
}

export type TransitionFrom = Id | '*';

export interface Transition {
  id: Id;
  from: TransitionFrom;
  to: Id;
  trigger?: string;
  guard?: string;
  priority: number;
  timeout?: TransitionTimeout;
  description?: string;
}

export interface Sequence {
  states: State[];
  transitions: Transition[];
}

export interface Station {
  id: Id;
  name: string;
  equipment: Equipment[];
  sequence: Sequence;
  description?: string;
  provenance?: Provenance;
}

export type AlarmSeverity = 'info' | 'warn' | 'critical';

export interface Alarm {
  id: Id;
  severity: AlarmSeverity;
  text_i18n: Record<string, string>;
  when?: string;
  ack_required: boolean;
  category?: string;
  description?: string;
}

export interface Interlock {
  id: Id;
  inhibits: string;
  when: string;
  description?: string;
}

export type ParameterDataType = 'int' | 'dint' | 'real' | 'bool';

export interface Parameter {
  id: Id;
  name: string;
  data_type: ParameterDataType;
  default: number | boolean;
  min?: number;
  max?: number;
  unit?: string;
  description?: string;
}

export interface Recipe {
  id: Id;
  name: string;
  values: Record<Id, number | boolean>;
  description?: string;
}

export type SafetyCategory =
  | 'emergency_stop'
  | 'light_curtain'
  | 'door'
  | 'two_hand'
  | 'other';

export type SafetyAffectRef =
  | { kind: 'station'; station_id: Id }
  | { kind: 'equipment'; equipment_id: Id };

export interface SafetyGroup {
  id: Id;
  name: string;
  trigger: string;
  affects: SafetyAffectRef[];
  category: SafetyCategory;
  description?: string;
}

export interface NamingProfile {
  equipment_symbol_pattern?: string;
  io_symbol_pattern?: string;
}

export interface Machine {
  id: Id;
  name: string;
  description?: string;
  stations: Station[];
  io: IoSignal[];
  alarms: Alarm[];
  interlocks: Interlock[];
  parameters: Parameter[];
  recipes: Recipe[];
  safety_groups: SafetyGroup[];
  naming?: NamingProfile;
}

export interface Project {
  pir_version: PirVersion;
  id: Id;
  name: string;
  machines: Machine[];
  description?: string;
  provenance?: Provenance;
}

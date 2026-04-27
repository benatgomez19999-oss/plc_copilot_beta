import type { EquipmentType } from '../types.js';

export interface EquipmentShape {
  type: EquipmentType;
  required_io: readonly string[];
  optional_io: readonly string[];
  required_timing: readonly string[];
  optional_timing: readonly string[];
  allowed_activities: readonly string[];
}

export const EQUIPMENT_SHAPES: Record<EquipmentType, EquipmentShape> = {
  pneumatic_cylinder_2pos: {
    type: 'pneumatic_cylinder_2pos',
    required_io: ['solenoid_out', 'sensor_extended', 'sensor_retracted'],
    optional_io: [],
    required_timing: ['extend_timeout_ms', 'retract_timeout_ms'],
    optional_timing: [],
    allowed_activities: ['extend', 'retract'],
  },
  pneumatic_cylinder_1pos: {
    type: 'pneumatic_cylinder_1pos',
    required_io: ['solenoid_out', 'sensor_extended'],
    optional_io: [],
    required_timing: ['extend_timeout_ms', 'retract_time_ms'],
    optional_timing: [],
    allowed_activities: ['extend', 'retract'],
  },
  motor_simple: {
    type: 'motor_simple',
    required_io: ['run_out'],
    optional_io: ['running_fb', 'fault_fb'],
    required_timing: [],
    optional_timing: ['start_timeout_ms', 'stop_timeout_ms'],
    allowed_activities: ['run'],
  },
  motor_vfd_simple: {
    type: 'motor_vfd_simple',
    required_io: ['run_out', 'speed_setpoint_out'],
    optional_io: ['running_fb', 'fault_fb', 'speed_fb'],
    required_timing: [],
    optional_timing: ['start_timeout_ms', 'stop_timeout_ms'],
    allowed_activities: ['run'],
  },
  valve_onoff: {
    type: 'valve_onoff',
    required_io: ['solenoid_out'],
    optional_io: ['open_fb', 'closed_fb'],
    required_timing: [],
    optional_timing: ['open_timeout_ms', 'close_timeout_ms'],
    allowed_activities: ['open', 'close'],
  },
  sensor_discrete: {
    type: 'sensor_discrete',
    required_io: ['signal_in'],
    optional_io: [],
    required_timing: [],
    optional_timing: ['debounce_ms'],
    allowed_activities: [],
  },
  sensor_analog: {
    type: 'sensor_analog',
    required_io: ['signal_in'],
    optional_io: [],
    required_timing: [],
    optional_timing: [],
    allowed_activities: [],
  },
  indicator_light: {
    type: 'indicator_light',
    required_io: ['light_out'],
    optional_io: [],
    required_timing: [],
    optional_timing: ['blink_ms'],
    allowed_activities: ['on', 'blink'],
  },
  supervisor: {
    type: 'supervisor',
    required_io: [],
    optional_io: [],
    required_timing: [],
    optional_timing: [],
    allowed_activities: [],
  },
};

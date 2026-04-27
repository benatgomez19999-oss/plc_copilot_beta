export function kindOf(type) {
    switch (type) {
        case 'pneumatic_cylinder_2pos':
        case 'pneumatic_cylinder_1pos':
        case 'motor_simple':
        case 'motor_vfd_simple':
        case 'valve_onoff':
            return 'actuator';
        case 'sensor_discrete':
        case 'sensor_analog':
            return 'sensor';
        case 'indicator_light':
            return 'indicator';
        case 'supervisor':
            return 'supervisor';
    }
}

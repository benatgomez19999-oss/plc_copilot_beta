// Backwards-compat shim. The canonical FB_Alarms builder lives in
// `@plccopilot/codegen-core` (`buildFbAlarmsIR` / `FB_ALARMS_NAME`).
// Existing consumers that imported `generateFbAlarmsIR` from here continue
// to work via the alias below.

import { buildFbAlarmsIR, FB_ALARMS_NAME } from '@plccopilot/codegen-core';
import { SIEMENS_DIR } from '../naming.js';

export { buildFbAlarmsIR as generateFbAlarmsIR, FB_ALARMS_NAME };
export const FB_ALARMS_PATH = `${SIEMENS_DIR}/${FB_ALARMS_NAME}.scl`;

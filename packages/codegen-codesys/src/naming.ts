import type { BackendNamespaceMap } from '@plccopilot/codegen-core';

/**
 * Codesys output directory + canonical artifact paths.
 */
export const CODESYS_DIR = 'codesys';
export const CODESYS_MANIFEST_PATH = `${CODESYS_DIR}/manifest.json`;

/**
 * Canonical IR DB names → Codesys GVL aliases. Owned by this package, NOT
 * by core. The Codesys renderers pass this map to `renderRef` /
 * `renderSymbol` / `renderStorage` from `@plccopilot/codegen-core`.
 */
export const CODESYS_NAMESPACES: BackendNamespaceMap = Object.freeze({
  DB_Alarms: 'GVL_Alarms',
  DB_Global_Params: 'GVL_Parameters',
  DB_Recipes: 'GVL_Recipes',
});

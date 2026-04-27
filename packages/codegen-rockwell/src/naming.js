export const ROCKWELL_DIR = 'rockwell';
export const ROCKWELL_MANIFEST_PATH = `${ROCKWELL_DIR}/manifest.json`;
/**
 * Canonical IR DB names → Rockwell controller-tag aliases. Owned by this
 * package, not by core. Studio 5000 has no GVL concept; the bare prefixes
 * (`Alarms`, `Parameters`, `Recipes`) are POC controller-tag conventions.
 */
export const ROCKWELL_NAMESPACES = Object.freeze({
    DB_Alarms: 'Alarms',
    DB_Global_Params: 'Parameters',
    DB_Recipes: 'Recipes',
});

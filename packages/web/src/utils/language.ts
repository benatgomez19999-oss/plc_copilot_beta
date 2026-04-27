/**
 * Map an artifact (`path` + `kind`) to a Monaco language id.
 *
 * Resolution order:
 *   1. File extension (case-insensitive). Wins because the path is the most
 *      specific signal we have — `manifest.json` should always be `json`
 *      regardless of how the producing backend tags the artifact `kind`.
 *   2. `kind` field — kicks in when a path lacks an extension or has a
 *      vendor-specific one we don't recognise.
 *   3. `'plaintext'` fallback.
 *
 * The returned ids match Monaco's built-in languages (`json`, `plaintext`)
 * or our custom registrations (`scl`, `structured-text` — registered by
 * `registerPlcLanguages`).
 *
 * Pure: no DOM, no Monaco. Test directly with strings.
 */
export type ArtifactLanguageId =
  | 'json'
  | 'scl'
  | 'structured-text'
  | 'plaintext';

export function detectArtifactLanguage(
  path: string,
  kind: string,
): ArtifactLanguageId {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.scl')) return 'scl';
  if (lower.endsWith('.st')) return 'structured-text';
  if (lower.endsWith('.csv')) return 'plaintext';

  switch (kind) {
    case 'json':
      return 'json';
    case 'scl':
      return 'scl';
    case 'st':
      return 'structured-text';
    case 'csv':
      return 'plaintext';
    default:
      return 'plaintext';
  }
}

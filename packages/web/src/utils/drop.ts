/**
 * Pure file-picker for drag-and-drop events. Separated from React so the
 * selection logic is unit-testable without a DOM environment.
 *
 *   - 0 files                     → error
 *   - 1+ files, no .json          → error (with the offending name)
 *   - 1+ files, ≥1 .json          → ok with the FIRST .json file
 *   - multiple .json files dropped → ok + multiple flag set (UI shows info)
 */
export type DropPickResult =
  | {
      kind: 'ok';
      file: File;
      multiple: boolean;
    }
  | {
      kind: 'error';
      message: string;
    };

const JSON_EXT = /\.json$/i;
const JSON_MIME = /^application\/json\b/;

function isJsonFile(file: File): boolean {
  return JSON_EXT.test(file.name) || JSON_MIME.test(file.type);
}

export function pickJsonFile(
  files: ReadonlyArray<File> | FileList | null,
): DropPickResult {
  const arr = files ? Array.from(files) : [];
  if (arr.length === 0) {
    return { kind: 'error', message: 'No file detected in the drop event.' };
  }

  const jsonFiles = arr.filter(isJsonFile);
  if (jsonFiles.length === 0) {
    const first = arr[0]!;
    return {
      kind: 'error',
      message: `Expected a .json file (got "${first.name || 'unknown'}").`,
    };
  }

  return {
    kind: 'ok',
    file: jsonFiles[0]!,
    multiple: arr.length > 1,
  };
}

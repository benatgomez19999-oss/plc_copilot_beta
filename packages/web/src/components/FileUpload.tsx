import { useRef } from 'react';
import type { Project } from '@plccopilot/pir';
import { readProjectFromFile } from '../utils/read-file.js';

export interface FileUploadProps {
  onLoad: (project: Project, fileName: string) => void;
  onError: (message: string) => void;
}

export function FileUpload({ onLoad, onError }: FileUploadProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <label className="file-upload">
      <span className="btn">Upload PIR JSON</span>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const result = await readProjectFromFile(file);
          if (result.ok) {
            onLoad(result.project, file.name);
          } else {
            onError(result.error);
          }
          // Allow re-selecting the same file.
          if (inputRef.current) inputRef.current.value = '';
        }}
        style={{ display: 'none' }}
      />
    </label>
  );
}

import { useEffect, useRef, useState } from 'react';
import { pickJsonFile } from '../utils/drop.js';

export interface DropZoneProps {
  /** Called with the picked .json File when the user drops one. */
  onFile: (file: File, opts: { multiple: boolean }) => void;
  /** Called with a user-facing message when the drop cannot be accepted. */
  onError: (message: string) => void;
}

/**
 * Document-level drag overlay. Listens on `window` for dragenter / dragover /
 * dragleave / drop, refcount-tracks nested-element leave events, and renders
 * a fullscreen overlay while a drag-with-files is in progress.
 *
 * When the user releases:
 *   - one .json file              → onFile(file, { multiple: false })
 *   - several files, ≥1 .json     → onFile(firstJson, { multiple: true })
 *   - no .json                    → onError("Expected a .json file …")
 */
export function DropZone({ onFile, onError }: DropZoneProps): JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const counterRef = useRef(0);

  useEffect(() => {
    function hasFiles(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).includes('Files');
    }

    function onDragEnter(e: DragEvent): void {
      if (!hasFiles(e)) return;
      e.preventDefault();
      counterRef.current += 1;
      setIsDragging(true);
    }

    function onDragOver(e: DragEvent): void {
      if (!hasFiles(e)) return;
      // Required so the subsequent `drop` event fires.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }

    function onDragLeave(e: DragEvent): void {
      if (!hasFiles(e)) return;
      counterRef.current = Math.max(0, counterRef.current - 1);
      if (counterRef.current === 0) setIsDragging(false);
    }

    function onDrop(e: DragEvent): void {
      e.preventDefault();
      counterRef.current = 0;
      setIsDragging(false);

      const result = pickJsonFile(e.dataTransfer?.files ?? null);
      if (result.kind === 'error') {
        onError(result.message);
        return;
      }
      onFile(result.file, { multiple: result.multiple });
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFile, onError]);

  if (!isDragging) return <></>;

  return (
    <div className="dropzone-overlay" role="presentation" aria-hidden="true">
      <div className="dropzone-card">
        <strong>Drop your PIR JSON to load it</strong>
        <p className="muted">.json files only · everything stays in your browser</p>
      </div>
    </div>
  );
}

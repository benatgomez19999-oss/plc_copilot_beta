import type { BackendChoice } from '../compiler/compile.js';

export interface BackendSelectorProps {
  value: BackendChoice;
  onChange: (next: BackendChoice) => void;
}

const OPTIONS: ReadonlyArray<{ value: BackendChoice; label: string }> = [
  { value: 'siemens', label: 'Siemens (production)' },
  { value: 'codesys', label: 'Codesys (experimental)' },
  { value: 'rockwell', label: 'Rockwell (experimental)' },
  { value: 'all', label: 'All backends' },
];

export function BackendSelector({
  value,
  onChange,
}: BackendSelectorProps): JSX.Element {
  return (
    <label className="backend-selector">
      <span className="label">Backend:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as BackendChoice)}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

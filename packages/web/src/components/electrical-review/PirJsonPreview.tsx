// Sprint 77 — pretty PIR JSON preview. The component never
// formats placeholder data as "real" — when the builder emitted
// a placeholder-sequence diagnostic, we surface it explicitly
// above the JSON.

import type { PirBuildResult } from '@plccopilot/electrical-ingest';

import { formatPirJson } from '../../utils/pir-build-preview.js';

export interface PirJsonPreviewProps {
  result: PirBuildResult | null;
}

export function PirJsonPreview({ result }: PirJsonPreviewProps): JSX.Element {
  if (!result) {
    return (
      <section className="pir-json-preview pir-json-preview--empty" aria-label="PIR preview JSON">
        <p className="muted">
          No PIR preview yet. Build one from the review panel above.
        </p>
      </section>
    );
  }
  if (!result.pir) {
    return (
      <section className="pir-json-preview pir-json-preview--refused" aria-label="PIR preview JSON">
        <p className="muted">
          <strong>Builder refused.</strong> See the build diagnostics
          below for why. No PIR JSON was produced.
        </p>
      </section>
    );
  }

  const json = formatPirJson(result);
  const usedPlaceholderSequence = (result.diagnostics ?? []).some(
    (d) => d.code === 'PIR_BUILD_PLACEHOLDER_SEQUENCE_USED',
  );
  const usedSourceMapSidecar = (result.diagnostics ?? []).some(
    (d) => d.code === 'PIR_BUILD_SOURCE_REFS_SIDECAR_USED',
  );
  const machineIo = result.pir.machines[0]?.io.length ?? 0;
  const stationEquipment =
    result.pir.machines[0]?.stations[0]?.equipment.length ?? 0;

  return (
    <section className="pir-json-preview" aria-label="PIR preview JSON">
      <header className="panel-header">
        <h3>PIR preview JSON</h3>
        <span className="badge build-status--built" role="status">
          {machineIo} IO / {stationEquipment} equipment
        </span>
      </header>

      <p className="muted pir-json-preview-disclaimer">
        This is a <strong>PIR preview</strong> built from reviewed
        electrical evidence. It validates against the
        <code> @plccopilot/pir </code>
        schema, but downstream codegen is still a manual
        operator-approved step.
      </p>

      {usedPlaceholderSequence ? (
        <p className="muted placeholder-sequence-note" role="note">
          <strong>Placeholder sequence:</strong> Sprint 76 v0 emits a
          minimal <code>init → terminal</code> sequence so the
          schema validates. The real sequence reviewing flow is
          still future work.
        </p>
      ) : null}

      {usedSourceMapSidecar ? (
        <p className="muted source-map-note" role="note">
          Source refs are preserved in the <code>sourceMap</code>{' '}
          sidecar (rendered separately) — PIR's schema does not
          carry <code>SourceRef[]</code> directly.
        </p>
      ) : null}

      <pre className="pir-json-preview-content" tabIndex={0}>
        <code>{json}</code>
      </pre>
    </section>
  );
}

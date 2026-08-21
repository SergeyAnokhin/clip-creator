import { AlertTriangle } from 'lucide-react';

/** Shown in the stage body when the last generation was a backend stub rather
 * than a model reply (no API key / no model picked / unsupported provider).
 *
 * The backend answers 200 with plausible-looking placeholder text in that
 * case, so without this the only tell was a red line inside a collapsed debug
 * panel - next to a green "Done!" toast. It sits outside the debug panel on
 * purpose: this one has to stay visible with developer mode off. */
export default function StubBanner({ L, message }) {
  return (
    <div className="stub-banner">
      <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>{L.stageStub_banner}</div>
        <div style={{ color: 'rgba(255,255,255,0.75)' }}>{message}</div>
      </div>
    </div>
  );
}

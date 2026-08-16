import { Trash2 } from 'lucide-react';
import { EffectSlider } from './PosterPanels.jsx';
import {
  MAX_OVERLAY_WIDTH_PCT, MIN_OVERLAY_MS, MIN_OVERLAY_WIDTH_PCT, OVERLAY_POSITIONS,
} from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';

/** Properties strip for the overlay currently selected on the overlay lane -
 * the numeric/grid counterpart to that lane's direct-manipulation gestures
 * (drag = move in time, edge drag = resize). Position is a 9-point grid
 * (matches `providers/editor.py`'s `_OVERLAY_XY_EXPR`) rather than free
 * drag-on-canvas placement - see the plan's v1 scoping note. */
export default function TimelineOverlayInspector({
  L, overlay, projectId, titleCardVariants, logos, actions,
}) {
  if (!overlay) return null;
  const { label } = resolveOverlaySource(overlay, { projectId, titleCardVariants, logos, L });

  function commitTiming(nextStartMs, nextDurationMs) {
    const startMs = Math.max(0, nextStartMs);
    const durationMs = Math.max(MIN_OVERLAY_MS, nextDurationMs);
    actions.setOverlayTiming(overlay.overlay_id, Math.round(startMs), Math.round(durationMs));
  }

  return (
    <div className="tl-inspector">
      <span className="tl-inspector-title">{L.overlay_inspectorTitle}</span>
      <span className="tl-overlay-inspector-label tl-inspector-row">{label}</span>

      <span className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.overlay_timingLabel}</span>
        <input
          type="number" step="0.1" min={0}
          className="field tl-inspector-num" value={(overlay.start_ms / 1000).toFixed(1)}
          aria-label={L.overlay_startLabel}
          onChange={(e) => commitTiming(Number(e.target.value) * 1000, overlay.duration_ms)}
        />
        <span className="tl-inspector-arrow">→</span>
        <input
          type="number" step="0.1" min={MIN_OVERLAY_MS / 1000}
          className="field tl-inspector-num" value={((overlay.start_ms + overlay.duration_ms) / 1000).toFixed(1)}
          aria-label={L.overlay_endLabel}
          onChange={(e) => commitTiming(overlay.start_ms, Number(e.target.value) * 1000 - overlay.start_ms)}
        />
      </span>

      <div className="tl-inspector-row tl-position-grid" role="group" aria-label={L.overlay_positionLabel}>
        {OVERLAY_POSITIONS.map((pos) => (
          <button
            key={pos}
            type="button"
            className={`tl-position-cell${overlay.position === pos ? ' is-selected' : ''}`}
            title={L[`overlay_position_${pos.replace(/-/g, '_')}`]}
            aria-label={L[`overlay_position_${pos.replace(/-/g, '_')}`]}
            onClick={() => actions.setOverlayPosition(overlay.overlay_id, pos)}
          >
            <span />
          </button>
        ))}
      </div>

      <div className="tl-inspector-row" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <EffectSlider
          label={L.overlay_widthLabel} value={overlay.width_pct} min={MIN_OVERLAY_WIDTH_PCT} max={MAX_OVERLAY_WIDTH_PCT}
          unit="%" onChange={(v) => actions.setOverlayWidthPct(overlay.overlay_id, v)} L={L}
        />
        <EffectSlider
          label={L.overlay_opacityLabel} value={Math.round(overlay.opacity * 100)} min={0} max={100}
          unit="%" onChange={(v) => actions.setOverlayOpacity(overlay.overlay_id, v / 100)} L={L}
        />
      </div>

      <div className="tl-inspector-actions">
        <button
          className="icon-btn icon-btn-danger" title={L.overlay_remove}
          onClick={() => actions.removeOverlay(overlay.overlay_id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

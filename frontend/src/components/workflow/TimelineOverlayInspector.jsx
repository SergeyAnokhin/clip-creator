import { Rewind, Trash2 } from 'lucide-react';
import { EffectSlider } from './PosterPanels.jsx';
import { MAX_OVERLAY_WIDTH_PCT, MIN_OVERLAY_MS, MIN_OVERLAY_WIDTH_PCT } from '../../lib/overlays.js';
import { resolveOverlaySource } from '../../lib/overlaySource.js';

/** Properties strip for the overlay currently selected on the overlay lane -
 * the numeric counterpart to that lane's own direct-manipulation gestures
 * (drag = move in time, edge drag = resize) *and* to the program monitor's
 * drag/resize/rotate canvas (`EditorPreview.jsx`, via the shared
 * `CanvasLayer` primitive) - a precise-entry fallback for the same
 * `x_pct`/`y_pct`/`width_pct`/`height_pct`/`rotation_deg` fields, not a
 * second source of truth. */
export default function TimelineOverlayInspector({
  L, overlay, projectId, titleCardVariants, logos, overlayVideoSources, actions,
}) {
  if (!overlay) return null;
  const { label } = resolveOverlaySource(overlay, {
    projectId, titleCardVariants, logos, overlayVideoSources, L,
  });

  function commitTiming(nextStartMs, nextDurationMs) {
    const startMs = Math.max(0, nextStartMs);
    const durationMs = Math.max(MIN_OVERLAY_MS, nextDurationMs);
    actions.setOverlayTiming(overlay.overlay_id, Math.round(startMs), Math.round(durationMs));
  }
  function setTransform(patch) {
    actions.setOverlayTransform(overlay.overlay_id, patch);
  }
  // Width/height used to be two independent sliders, which let them drift
  // apart and stretch the overlay's content out of its own aspect ratio -
  // one "scale" slider keeps that ratio by moving both percentages by the
  // same factor (mirrors dragging a corner handle on the program monitor,
  // which Konva's Transformer already keeps locked to the natural aspect).
  function scaleTo(nextWidthPct) {
    const factor = nextWidthPct / overlay.width_pct;
    // height_axis stamped here too - see lib/overlays.js's overlayPatchFromCanvasLayer.
    setTransform({ width_pct: nextWidthPct, height_pct: overlay.height_pct * factor, height_axis: 'width' });
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

      <span className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.overlay_xLabel}</span>
        <input
          type="number" step="1"
          className="field tl-inspector-num" value={Math.round(overlay.x_pct)}
          aria-label={L.overlay_xLabel}
          onChange={(e) => setTransform({ x_pct: Number(e.target.value) })}
        />
        <span className="tl-inspector-rowlabel">{L.overlay_yLabel}</span>
        <input
          type="number" step="1"
          className="field tl-inspector-num" value={Math.round(overlay.y_pct)}
          aria-label={L.overlay_yLabel}
          onChange={(e) => setTransform({ y_pct: Number(e.target.value) })}
        />
      </span>

      <div className="tl-inspector-row" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <EffectSlider
          label={L.overlay_scaleLabel} value={Math.round(overlay.width_pct)} min={MIN_OVERLAY_WIDTH_PCT} max={MAX_OVERLAY_WIDTH_PCT}
          unit="%" onChange={(v) => scaleTo(v)} L={L}
        />
        <EffectSlider
          label={L.overlay_rotationLabel} value={Math.round(overlay.rotation_deg)} min={0} max={360}
          unit="°" onChange={(v) => setTransform({ rotation_deg: v })} L={L}
        />
        <EffectSlider
          label={L.overlay_opacityLabel} value={Math.round(overlay.opacity * 100)} min={0} max={100}
          unit="%" onChange={(v) => actions.setOverlayOpacity(overlay.overlay_id, v / 100)} L={L}
        />
      </div>

      <span className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.overlay_fadeInLabel}</span>
        <input
          type="number" step="0.1" min={0}
          className="field tl-inspector-num" value={((overlay.fade_in_ms || 0) / 1000).toFixed(1)}
          aria-label={L.overlay_fadeInLabel}
          onChange={(e) => actions.setOverlayFade(overlay.overlay_id, Math.max(0, Number(e.target.value) * 1000), overlay.fade_out_ms || 0)}
        />
        <span className="tl-inspector-rowlabel">{L.overlay_fadeOutLabel}</span>
        <input
          type="number" step="0.1" min={0}
          className="field tl-inspector-num" value={((overlay.fade_out_ms || 0) / 1000).toFixed(1)}
          aria-label={L.overlay_fadeOutLabel}
          onChange={(e) => actions.setOverlayFade(overlay.overlay_id, overlay.fade_in_ms || 0, Math.max(0, Number(e.target.value) * 1000))}
        />
      </span>

      <div className="tl-inspector-actions">
        {overlay.kind === 'video' && (
          <button
            className={`icon-btn${overlay.reverse ? ' is-active' : ''}`}
            title={L.overlay_reverseLabel} aria-pressed={!!overlay.reverse}
            onClick={() => actions.setOverlayReverse(overlay.overlay_id, !overlay.reverse)}
          >
            <Rewind size={14} />
          </button>
        )}
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

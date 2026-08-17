import {
  Copy, Rewind, RotateCcw, Trash2,
} from 'lucide-react';
import {
  DEFAULT_FADE_MS, DEFAULT_FIT, MAX_FIT_ZOOM, MAX_SPEED, MIN_FIT_ZOOM, MIN_SPEED, clampTrim,
} from '../../lib/timeline.js';
import { EffectSlider } from './PosterPanels.jsx';

/** One fade row (in or out): a duration field (0 = off) plus a black/white
 * swatch pair that both picks the colour and - if the fade was off - turns
 * it on at `DEFAULT_FADE_MS`. A top-level component (not nested inside
 * TimelineClipInspector) so React doesn't see a "new" component type on
 * every render, which would remount the `<input>` and drop its focus after
 * every keystroke. */
function FadeRow({ L, label, fade, onSet }) {
  const color = fade?.color || 'black';
  return (
    <span className="tl-inspector-label tl-inspector-row">
      <span className="tl-inspector-rowlabel">{label}</span>
      <input
        type="number" step="0.1" min={0}
        className="field tl-inspector-num" value={fade ? (fade.duration_ms / 1000).toFixed(1) : '0'}
        onChange={(e) => onSet(color, Math.max(0, Number(e.target.value)) * 1000)}
      />
      <button
        type="button" className={`tl-fade-swatch tl-fade-swatch-black${color === 'black' ? ' is-selected' : ''}`}
        title={L.editor_fadeColorBlack} aria-label={L.editor_fadeColorBlack}
        onClick={() => onSet('black', fade?.duration_ms || DEFAULT_FADE_MS)}
      />
      <button
        type="button" className={`tl-fade-swatch tl-fade-swatch-white${color === 'white' ? ' is-selected' : ''}`}
        title={L.editor_fadeColorWhite} aria-label={L.editor_fadeColorWhite}
        onClick={() => onSet('white', fade?.duration_ms || DEFAULT_FADE_MS)}
      />
    </span>
  );
}

/** How a clip whose own aspect ratio doesn't match the render canvas fills
 * it - `Заполнить` (cover, the default when `fit` is absent: fills the
 * frame, cropping overflow, no letterbox bars) or `Вписать` (contain: the
 * old always-letterboxed behavior, kept as an explicit opt-in). Cover mode
 * additionally exposes zoom + pan (`offset_x_pct`/`offset_y_pct`, 0-100%
 * within the overscanned crop window, 50/50 = centered) for repositioning
 * what's visible - mirrors `providers/editor.py`'s `build_ffmpeg_command`
 * crop-vs-pad branch exactly (see that module for the filter math). A
 * top-level component for the same remount/focus reason `FadeRow` is. */
function ClipFitRow({ L, fit, onChange }) {
  const mode = fit?.mode === 'contain' ? 'contain' : 'cover';
  const zoom = fit?.zoom || DEFAULT_FIT.zoom;
  const offsetXPct = fit?.offset_x_pct ?? DEFAULT_FIT.offset_x_pct;
  const offsetYPct = fit?.offset_y_pct ?? DEFAULT_FIT.offset_y_pct;

  function setMode(nextMode) {
    onChange(nextMode === 'contain' ? { mode: 'contain' } : { mode: 'cover', zoom, offset_x_pct: offsetXPct, offset_y_pct: offsetYPct });
  }
  function patchCover(patch) {
    onChange({ mode: 'cover', zoom, offset_x_pct: offsetXPct, offset_y_pct: offsetYPct, ...patch });
  }

  return (
    <div className="tl-inspector-row" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="tl-inspector-label">
        <span className="tl-inspector-rowlabel">{L.editor_clipFitLabel}</span>
      </span>
      <div className="tl-inspector-row tl-transition-types">
        <button
          type="button" className={`tl-transition-chip${mode === 'cover' ? ' is-selected' : ''}`}
          onClick={() => setMode('cover')}
        >
          {L.editor_clipFitCover}
        </button>
        <button
          type="button" className={`tl-transition-chip${mode === 'contain' ? ' is-selected' : ''}`}
          onClick={() => setMode('contain')}
        >
          {L.editor_clipFitContain}
        </button>
      </div>
      {mode === 'cover' && (
        <>
          <EffectSlider
            label={L.editor_clipFitZoomLabel} value={Math.round(zoom * 100)} min={MIN_FIT_ZOOM * 100} max={MAX_FIT_ZOOM * 100}
            unit="%" onChange={(v) => patchCover({ zoom: v / 100 })} L={L}
          />
          <EffectSlider
            label={L.editor_clipFitOffsetXLabel} value={Math.round(offsetXPct)} min={0} max={100}
            unit="%" onChange={(v) => patchCover({ offset_x_pct: v })} L={L}
          />
          <EffectSlider
            label={L.editor_clipFitOffsetYLabel} value={Math.round(offsetYPct)} min={0} max={100}
            unit="%" onChange={(v) => patchCover({ offset_y_pct: v })} L={L}
          />
        </>
      )}
    </div>
  );
}

/** Properties strip for the clip currently selected on the timeline - the
 * numeric counterpart to the direct-manipulation gestures in
 * EditorTimeline.jsx (drag = reorder, edge drag = trim). Everything here is
 * exact-value editing that a drag can't do well: which generated video
 * variant the clip uses, the trim window to a tenth of a second, and speed.
 * A multi-selection can't sensibly show these fields for N heterogeneous
 * clips at once, so it falls back to a summary with just duplicate/remove. */
export default function TimelineClipInspector({
  L, clip, scene, sourceDurationMs, selectedCount, selectedClipIds, actions,
}) {
  if (selectedCount > 1) {
    const ids = Array.from(selectedClipIds);
    return (
      <div className="tl-inspector tl-inspector-multi">
        <span className="tl-inspector-title">{L.editor_clipsSelected.replace('{n}', selectedCount)}</span>
        <button className="icon-btn" title={L.editor_clipsSelectedDuplicate} onClick={() => actions.duplicateClips(ids)}>
          <Copy size={14} />
        </button>
        <button className="icon-btn icon-btn-danger" title={L.editor_clipsSelectedRemove} onClick={() => actions.removeClips(ids)}>
          <Trash2 size={14} />
        </button>
      </div>
    );
  }

  if (!clip) {
    return <div className="tl-inspector tl-inspector-empty">{L.editor_clipSelectHint}</div>;
  }

  const videos = scene?.videos || [];

  function commitTrim(nextStartMs, nextEndMs) {
    // Nothing to clamp *against* for an imported/uploaded clip with no known
    // duration (sourceDurationMs 0) - just keep start >= 0 and end > start,
    // same floor clampTrim uses.
    if (sourceDurationMs > 0) {
      const { trimStartMs, trimEndMs } = clampTrim(nextStartMs, nextEndMs, sourceDurationMs);
      actions.setClipTrim(clip.clip_id, trimStartMs, trimEndMs);
    } else {
      const start = Math.max(0, nextStartMs);
      actions.setClipTrim(clip.clip_id, start, Math.max(start + 100, nextEndMs));
    }
  }

  const isDefault = (clip.trim_start_ms || 0) === 0 && clip.trim_end_ms == null && (clip.speed || 1) === 1 && !clip.reverse;

  return (
    <div className="tl-inspector">
      <span className="tl-inspector-title">{L.editor_clipInspectorTitle}</span>

      <select
        className="field tl-inspector-field tl-inspector-row" value={clip.video_id}
        onChange={(e) => actions.changeClipVideo(clip.clip_id, e.target.value)}
      >
        {videos.map((v, i) => (
          <option key={v.video_id} value={v.video_id}>{`${L.editor_clipVideoOption} ${i + 1} (${v.duration_seconds || '?'}s)`}</option>
        ))}
      </select>

      <span className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.editor_clipTrimLabel}</span>
        <input
          type="number" step="0.1" min={0} {...(sourceDurationMs > 0 ? { max: (sourceDurationMs / 1000).toFixed(1) } : {})}
          className="field tl-inspector-num" value={(clip.trimStartMs / 1000).toFixed(1)}
          aria-label={L.editor_clipTrimStartLabel}
          onChange={(e) => commitTrim(Number(e.target.value) * 1000, clip.trimEndMs)}
        />
        <span className="tl-inspector-arrow">→</span>
        <input
          type="number" step="0.1" min={0} {...(sourceDurationMs > 0 ? { max: (sourceDurationMs / 1000).toFixed(1) } : {})}
          className="field tl-inspector-num" value={(clip.trimEndMs / 1000).toFixed(1)}
          aria-label={L.editor_clipTrimEndLabel}
          onChange={(e) => commitTrim(clip.trimStartMs, Number(e.target.value) * 1000)}
        />
      </span>

      <label className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.editor_clipSpeedLabel}</span>
        <input
          type="number" step="0.25" min={MIN_SPEED} max={MAX_SPEED}
          className="field tl-inspector-num" value={clip.speed || 1}
          onChange={(e) => actions.setClipSpeed(clip.clip_id, Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(e.target.value) || 1)))}
        />
        <span className="tl-inspector-arrow">×</span>
        <button
          type="button" className={`icon-btn${clip.reverse ? ' is-active' : ''}`}
          title={L.editor_clipReverseTooltip} aria-pressed={!!clip.reverse}
          onClick={() => actions.setClipReverse(clip.clip_id, !clip.reverse)}
        >
          <Rewind size={14} />
        </button>
      </label>

      <ClipFitRow L={L} fit={clip.fit} onChange={(fit) => actions.setClipFit(clip.clip_id, fit)} />

      <FadeRow L={L} label={L.editor_fadeInLabel} fade={clip.fade_in} onSet={(color, ms) => actions.setClipFadeIn(clip.clip_id, color, ms)} />
      <FadeRow L={L} label={L.editor_fadeOutLabel} fade={clip.fade_out} onSet={(color, ms) => actions.setClipFadeOut(clip.clip_id, color, ms)} />

      {!sourceDurationMs && <span className="tl-inspector-warn tl-inspector-row">⚠ {L.editor_unknownDuration}</span>}

      <div className="tl-inspector-actions">
        <button
          className="icon-btn" title={L.editor_clipReset} disabled={isDefault}
          onClick={() => actions.resetClip(clip.clip_id)}
        >
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn icon-btn-danger" title={L.editor_clipRemove} onClick={() => actions.removeClips([clip.clip_id])}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

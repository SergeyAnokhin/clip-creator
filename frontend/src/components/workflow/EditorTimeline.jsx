import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Plus, Scissors, ZoomIn, ZoomOut } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { applyEdgeTrim, dropIndexForStart } from '../../lib/timeline.js';
import TimelineAudioTrack from './TimelineAudioTrack.jsx';
import TimelineClipInspector from './TimelineClipInspector.jsx';

// A zoomed-in timeline is one very wide DOM element (and one equally wide
// waveform <canvas>) - this caps how wide it may get, both for the browser's
// own canvas size limit and to keep scrolling smooth.
const MAX_CONTENT_PX = 20000;
const MIN_CONTENT_MS = 5000;
const RULER_STEPS_MS = [200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
const MIN_TICK_GAP_PX = 66;
const ZOOM_FACTOR = 1.6;
const VIDEO_TRACK_H = 66;
const AUDIO_TRACK_H = 42;

function formatTimecode(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function sceneLabel(scene, sceneIndex) {
  const text = scene?.scene_description || scene?.lyric_segment || '';
  return `${sceneIndex + 1}. ${text.length > 48 ? `${text.slice(0, 48)}…` : text}`;
}

function sceneThumb(scene) {
  const image = (scene?.images || []).find((img) => img.is_selected) || (scene?.images || [])[0];
  return image?.file_path || null;
}

function rulerStepMs(scale) {
  return RULER_STEPS_MS.find((step) => step * scale >= MIN_TICK_GAP_PX) || RULER_STEPS_MS[RULER_STEPS_MS.length - 1];
}

/** The Editor stage's timeline, laid out like a normal NLE (CapCut/Premiere):
 * a time ruler, one video row of clip blocks drawn to scale, the audio track's
 * waveform under it on the same scale, and a playhead across both. Everything
 * is direct manipulation - drag a block to reorder, drag its edges to trim,
 * drag the ruler to scrub, ctrl+wheel or the toolbar to zoom - with
 * TimelineClipInspector.jsx underneath for the exact values a drag can't set.
 *
 * Layout is purely a function of `scale` (px per output millisecond): the
 * clips arrive pre-annotated with `startMs`/`durationMs` from
 * `lib/timeline.js`, so nothing here recomputes timeline math, and every
 * gesture ends in one of the existing `useEditorStage` actions. The timeline
 * has no gaps by design - the render concatenates clips back to back - so a
 * horizontal drag means "change the order", not "move to this exact time". */
export default function EditorTimeline({
  L, projectId, scenes, clips, totalDurationMs, selectedTrack, playheadMs, isPlaying,
  selectedClipId, actions,
}) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const clipNodesRef = useRef({});
  const pendingScrollRef = useRef(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [zoomPxPerMs, setZoomPxPerMs] = useState(null); // null = fit the whole timeline
  const [drag, setDrag] = useState(null);
  const [dragDx, setDragDx] = useState(0);

  const audioDurationMs = selectedTrack?.duration_ms || 0;
  const contentDurationMs = Math.max(totalDurationMs, audioDurationMs, MIN_CONTENT_MS);
  const fitScale = viewportWidth / contentDurationMs;
  const maxScale = Math.max(fitScale, MAX_CONTENT_PX / contentDurationMs);
  const scale = Math.min(Math.max(zoomPxPerMs ?? fitScale, fitScale), maxScale);
  const contentWidth = contentDurationMs * scale;
  const stepMs = rulerStepMs(scale);
  const tickCount = Math.floor(contentDurationMs / stepMs) + 1;
  const selectedClip = clips.find((c) => c.clip_id === selectedClipId) || null;
  const selectedScene = selectedClip ? scenes?.[selectedClip.scene_index] : null;
  const selectedSourceMs = selectedClip
    ? ((selectedScene?.videos || []).find((v) => v.video_id === selectedClip.video_id)?.duration_seconds || 0) * 1000
    : 0;
  // The render freeze-frames the last clip over whatever audio is left - show
  // that tail on the timeline instead of letting the row just stop short.
  const padWidth = Math.max(0, audioDurationMs - totalDurationMs) * scale;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    setViewportWidth(el.clientWidth || 900);
    const observer = new ResizeObserver(([entry]) => setViewportWidth(entry.contentRect.width || 900));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function pointerToMs(clientX) {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, (clientX - rect.left) / scale);
  }

  // ---------- gestures ----------
  useEffect(() => {
    if (!drag) return undefined;

    function onMove(e) {
      if (drag.mode === 'scrub') {
        actions.seek(pointerToMs(e.clientX));
        return;
      }
      const dx = e.clientX - drag.startX;
      if (drag.mode === 'move') {
        setDragDx(dx);
        return;
      }
      const edge = drag.mode === 'trim-start' ? 'start' : 'end';
      const { trimStartMs, trimEndMs } = applyEdgeTrim(drag.clip, drag.sourceDurationMs, edge, dx / scale);
      actions.setClipTrim(drag.clip.clip_id, trimStartMs, trimEndMs);
    }

    function onUp(e) {
      if (drag.mode === 'move') {
        const newStartMs = drag.startMs + (e.clientX - drag.startX) / scale;
        const toIndex = dropIndexForStart(clipsRef.current, drag.index, newStartMs);
        if (toIndex !== drag.index) actions.reorderClip(drag.index, toIndex);
      }
      setDrag(null);
      setDragDx(0);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, scale]);

  function startScrub(e) {
    if (e.button !== 0) return;
    actions.seek(pointerToMs(e.clientX));
    setDrag({ mode: 'scrub' });
  }

  function startClipDrag(e, clip, index) {
    if (e.button !== 0) return;
    e.stopPropagation();
    actions.selectClip(clip.clip_id);
    setDrag({ mode: 'move', index, startX: e.clientX, startMs: clip.startMs });
  }

  function onClipKeyDown(e, clip) {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      actions.selectClip(clip.clip_id);
    }
  }

  function startTrimDrag(e, clip, edge) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const video = (scenes?.[clip.scene_index]?.videos || []).find((v) => v.video_id === clip.video_id);
    actions.selectClip(clip.clip_id);
    setDrag({
      mode: edge === 'start' ? 'trim-start' : 'trim-end',
      startX: e.clientX,
      clip,
      sourceDurationMs: (video?.duration_seconds || 0) * 1000,
    });
  }

  // ---------- zoom ----------
  function applyZoom(nextScaleRaw) {
    const el = scrollRef.current;
    const nextScale = Math.min(Math.max(nextScaleRaw, fitScale), maxScale);
    // Keep whatever is under the playhead (or the viewport centre when the
    // playhead is off screen) pinned in place while the scale changes.
    const scrollLeft = el?.scrollLeft || 0;
    const width = el?.clientWidth || viewportWidth;
    const playheadPx = playheadMs * scale;
    const anchorMs = playheadPx >= scrollLeft && playheadPx <= scrollLeft + width
      ? playheadMs
      : (scrollLeft + width / 2) / scale;
    const anchorOffsetPx = anchorMs * scale - scrollLeft;
    // Applied in the layout effect below, not here: the scroll offset only
    // exists once the re-render has actually widened the content, otherwise
    // the browser clamps it to the old (narrower) scroll range.
    pendingScrollRef.current = Math.max(0, anchorMs * nextScale - anchorOffsetPx);
    setZoomPxPerMs(nextScale);
  }

  useLayoutEffect(() => {
    if (pendingScrollRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
  }, [scale]);

  // Ctrl+wheel zoom has to be a native, explicitly non-passive listener:
  // React registers its own `wheel` handlers as passive, where
  // `preventDefault()` is ignored and the browser zooms the whole page
  // instead. Kept subscribed once, driving through refs, so a playing
  // playhead doesn't re-subscribe it 60 times a second.
  const zoomRef = useRef(null);
  zoomRef.current = (factor) => applyZoom(scale * factor);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    function onWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Follow the playhead while playing, but never fight a zoom/scroll the user
  // is doing by hand mid-playback (hence the generous margins).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying || drag) return;
    const x = playheadMs * scale;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [playheadMs, isPlaying, scale, drag]);

  function onKeyDown(e) {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (!clips.length) return;
      e.preventDefault();
      const currentIndex = clips.findIndex((c) => c.clip_id === selectedClipId);
      const nextIndex = e.code === 'ArrowLeft'
        ? Math.max(0, (currentIndex === -1 ? clips.length : currentIndex) - 1)
        : Math.min(clips.length - 1, currentIndex + 1);
      const nextClip = clips[nextIndex];
      actions.selectClip(nextClip.clip_id);
      clipNodesRef.current[nextClip.clip_id]?.focus();
      return;
    }
    if (e.target !== e.currentTarget) return;
    if (e.code === 'Space') {
      e.preventDefault();
      (isPlaying ? actions.pause : actions.play)();
    } else if (e.code === 'KeyS') {
      actions.splitAtPlayhead();
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedClipId) {
      e.preventDefault();
      actions.removeClip(selectedClipId);
    }
  }

  const usedSceneIndices = new Set(clips.map((c) => c.scene_index));
  const addableScenes = (scenes || [])
    .map((scene, sceneIndex) => ({ scene, sceneIndex }))
    .filter(({ scene, sceneIndex }) => !usedSceneIndices.has(sceneIndex) && (scene.videos || []).length > 0);

  return (
    <div className="tl-panel">
      <div className="tl-toolbar">
        <span className="tl-timecode">{formatTimecode(playheadMs)}<span className="tl-timecode-total"> / {formatTimecode(contentDurationMs)}</span></span>
        <button className="icon-btn" title={L.editor_toolSplit} onClick={actions.splitAtPlayhead} disabled={!clips.length}>
          <Scissors size={14} />
        </button>
        <div className="tl-toolbar-spacer" />
        <span className="tl-hint">{L.editor_timelineHint}</span>
        <button className="icon-btn" title={L.editor_toolZoomOut} onClick={() => applyZoom(scale / ZOOM_FACTOR)} disabled={scale <= fitScale}>
          <ZoomOut size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomFit} onClick={() => setZoomPxPerMs(null)}>
          <Maximize2 size={14} />
        </button>
        <button className="icon-btn" title={L.editor_toolZoomIn} onClick={() => applyZoom(scale * ZOOM_FACTOR)} disabled={scale >= maxScale}>
          <ZoomIn size={14} />
        </button>
      </div>

      {/* The scroll box is the timeline's own keyboard surface (arrows move
          between clips, Space/S/Delete act on them), so it has to be
          focusable and listen for keys while staying a container rather than
          a control - the two rules below assume that combination is a
          mistake. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
      <div className="tl-scroll" ref={scrollRef} role="application" aria-label={L.editor_timelineLabel} onKeyDown={onKeyDown} tabIndex={0}>
        <div
          className="tl-content" ref={contentRef} style={{ width: contentWidth }}
          onPointerDown={(e) => { actions.selectClip(null); startScrub(e); }}
        >
          <div className="tl-ruler">
            {Array.from({ length: tickCount }, (_, i) => (
              <div key={i} className="tl-tick" style={{ left: i * stepMs * scale }}>
                <span>{formatTimecode(i * stepMs)}</span>
              </div>
            ))}
          </div>

          <div className="tl-track" style={{ height: VIDEO_TRACK_H }}>
            {!clips.length && <div className="tl-track-empty">{L.editor_timelineEmpty}</div>}
            {clips.map((clip, index) => {
              const scene = scenes?.[clip.scene_index];
              const thumb = sceneThumb(scene);
              const isDragging = drag?.mode === 'move' && drag.index === index;
              const width = Math.max(8, clip.durationMs * scale);
              return (
                <div
                  key={clip.clip_id}
                  ref={(el) => { if (el) clipNodesRef.current[clip.clip_id] = el; else delete clipNodesRef.current[clip.clip_id]; }}
                  className={`tl-clip${clip.clip_id === selectedClipId ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}`}
                  style={{
                    left: clip.startMs * scale + (isDragging ? dragDx : 0),
                    width,
                    backgroundImage: thumb ? `url(${mediaUrl(`projects/${projectId}/${thumb}`)})` : undefined,
                  }}
                  onPointerDown={(e) => startClipDrag(e, clip, index)}
                  onKeyDown={(e) => onClipKeyDown(e, clip)}
                  title={sceneLabel(scene, clip.scene_index)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="tl-clip-handle tl-clip-handle-start" onPointerDown={(e) => startTrimDrag(e, clip, 'start')} />
                  <span className="tl-clip-label">
                    {sceneLabel(scene, clip.scene_index)}
                    {(clip.speed || 1) !== 1 && <b> · {clip.speed}×</b>}
                  </span>
                  <span className="tl-clip-handle tl-clip-handle-end" onPointerDown={(e) => startTrimDrag(e, clip, 'end')} />
                </div>
              );
            })}
            {padWidth > 2 && (
              <div className="tl-clip-pad" style={{ left: totalDurationMs * scale, width: padWidth }} title={L.editor_freezeTailHint}>
                <span>{L.editor_freezeTail}</span>
              </div>
            )}
          </div>

          <div className="tl-track tl-track-audio" style={{ height: AUDIO_TRACK_H }}>
            {selectedTrack ? (
              <TimelineAudioTrack
                projectId={projectId} track={selectedTrack}
                widthPx={audioDurationMs * scale} heightPx={AUDIO_TRACK_H}
              />
            ) : (
              <div className="tl-track-empty">{L.editor_noAudioTrack}</div>
            )}
          </div>

          <div className="tl-playhead" style={{ left: playheadMs * scale }}><span /></div>
        </div>
      </div>

      <TimelineClipInspector
        L={L} clip={selectedClip} scene={selectedScene} sourceDurationMs={selectedSourceMs} actions={actions}
      />

      {!!addableScenes.length && (
        <div className="tl-add-row">
          <span className="tl-hint">{L.editor_addSceneLabel}</span>
          {addableScenes.map(({ scene, sceneIndex }) => (
            <button
              key={sceneIndex} className="btn-ghost tl-add-chip"
              onClick={() => {
                const video = (scene.videos || []).find((v) => v.is_selected) || scene.videos[0];
                actions.addSceneClip(sceneIndex, video.video_id);
              }}
            >
              <Plus size={12} /> {sceneLabel(scene, sceneIndex)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

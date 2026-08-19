import { useEffect, useState } from 'react';
import {
  Clapperboard, Download, Loader2, Pause, Play, SkipBack, Trash2, Wand2,
} from 'lucide-react';
import EditorPreview from './EditorPreview.jsx';
import EditorTimeline from './EditorTimeline.jsx';
import KeyboardShortcutsModal from './KeyboardShortcutsModal.jsx';
import TestRangeModal from './TestRangeModal.jsx';
import { mediaUrl } from '../../api/client.js';
import { resolveCanvasSize } from '../../lib/canvasOrientation.js';

const DURATION_MISMATCH_THRESHOLD_MS = 1000;
const SIDE_WIDTH_STORAGE_KEY = 'editorSideWidthPx';
const DEFAULT_SIDE_WIDTH = 320;
const MIN_SIDE_WIDTH = 240;
const MAX_SIDE_WIDTH = 560;
const TEST_RANGE_STORAGE_KEY_PREFIX = 'editorTestRange_';
const DEFAULT_TEST_RANGE_MS = 10000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadStoredSideWidth() {
  try {
    const stored = Number(localStorage.getItem(SIDE_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH) : DEFAULT_SIDE_WIDTH;
  } catch {
    return DEFAULT_SIDE_WIDTH;
  }
}

// Test-render range is per-project (not part of `video_edit` - see the note
// on the `testRange` state below) but should still survive a reload, so it
// remembers the last range picked in `TestRangeModal.jsx` per project id,
// same `localStorage` pattern as the side-panel width above.
function loadStoredTestRange(projectId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEST_RANGE_STORAGE_KEY_PREFIX + projectId));
    if (Number.isFinite(parsed?.startMs) && Number.isFinite(parsed?.endMs) && parsed.endMs > parsed.startMs) return parsed;
  } catch { /* ignore */ }
  return null;
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

function formatTime(ms) {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** Editor stage - the final step: assembles the project's picked scene
 * video clips into one rendered file, synced to the project's selected
 * Mureka track. Laid out like a real NLE app, not a scrolling page: the
 * program monitor fills whatever height is left after the timeline
 * (EditorTimeline.jsx, docked to the very bottom), and every control that
 * isn't the monitor or the timeline's own ruler/clip/waveform rows lives in
 * the right-hand panel - playback transport, the timeline's own toolbar
 * (split/zoom, portaled in from EditorTimeline via `toolsSlot` below so
 * that component keeps owning its zoom/scroll state), the clip inspector,
 * and the render CTA pinned at the panel's own bottom. See
 * useEditorStage.js for the state/preview-engine design; this component is
 * layout only. */
export default function EditorStage({
  L, project, isMobile, videoEdit, clips, overlays, overlayVideoSources, totalDurationMs, selectedTrack, tracks,
  playheadMs, isPlaying, renderLoading, renderError, elapsedSeconds, selectedClipIds,
  selectedOverlayId, selectedTransitionClipId, logos, videoRef, audioRef, canUndo, canRedo, actions,
}) {
  const [toolsSlot, setToolsSlot] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sideWidthPx, setSideWidthPx] = useState(loadStoredSideWidth);
  const [resizeDrag, setResizeDrag] = useState(null);
  // The test-render range picked in TestRangeModal.jsx - a render-time
  // input, not part of the EDL, so it's plain local state here (persisted to
  // localStorage per project, not `video_edit`/undo history - see
  // `loadStoredTestRange` above) rather than going through
  // useEditorStage.js/commitVideoEdit.
  const [testRange, setTestRange] = useState(() => loadStoredTestRange(project.id));
  const [testRangeModalOpen, setTestRangeModalOpen] = useState(false);

  useEffect(() => {
    setTestRange(loadStoredTestRange(project.id));
  }, [project.id]);

  function confirmTestRange(range) {
    setTestRange(range);
    try { localStorage.setItem(TEST_RANGE_STORAGE_KEY_PREFIX + project.id, JSON.stringify(range)); } catch { /* ignore */ }
    setTestRangeModalOpen(false);
    actions.startRender({ range });
  }

  useEffect(() => {
    if (!isFullscreen) return undefined;
    function onKeyDown(e) {
      if (e.key === 'Escape') setIsFullscreen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  // Ctrl/Cmd+Z / Ctrl/Cmd+Y (or +Shift+Z) undo/redo, global to the stage
  // rather than tied to whatever has focus - mirrors PosterConstructor.jsx's
  // identical listener. Only mounted while this stage is on screen (see
  // WorkflowScreen.jsx), so it can't fight the poster editor's own binding.
  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        actions.undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        actions.redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions]);

  useEffect(() => {
    if (!resizeDrag) return undefined;
    function onMove(e) {
      setSideWidthPx(clamp(resizeDrag.startWidth - (e.clientX - resizeDrag.startX), MIN_SIDE_WIDTH, MAX_SIDE_WIDTH));
    }
    function onUp() {
      setResizeDrag(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [resizeDrag]);

  useEffect(() => {
    try { localStorage.setItem(SIDE_WIDTH_STORAGE_KEY, String(sideWidthPx)); } catch { /* ignore */ }
  }, [sideWidthPx]);

  const scenes = project.scenes || [];
  const titleCardVariants = project.title_card?.variants || [];
  const renders = [...(videoEdit.renders || [])].reverse();
  const mismatchMs = selectedTrack ? totalDurationMs - selectedTrack.duration_ms : 0;
  const showMismatch = selectedTrack && Math.abs(mismatchMs) > DURATION_MISMATCH_THRESHOLD_MS;
  const canRender = clips.length > 0 && !!selectedTrack;
  const timelineMs = Math.max(totalDurationMs, selectedTrack?.duration_ms || 0);
  const canvasOrientation = videoEdit.canvas_orientation || 'auto';
  const canvasSize = resolveCanvasSize(clips, scenes, canvasOrientation);

  return (
    <div className={`editor-stage${isMobile ? ' is-mobile' : ''}${isFullscreen ? ' editor-fullscreen' : ''}`}>
      <div className={`editor-layout${isMobile ? ' is-mobile' : ''}`}>
        <EditorPreview
          L={L} videoRef={videoRef} audioRef={audioRef} projectId={project.id} selectedTrack={selectedTrack}
          overlays={overlays} playheadMs={playheadMs} isPlaying={isPlaying}
          titleCardVariants={titleCardVariants} logos={logos}
          overlayVideoSources={overlayVideoSources} canvasSize={canvasSize}
          isFullscreen={isFullscreen} onToggleFullscreen={() => setIsFullscreen((v) => !v)}
          selectedOverlayId={selectedOverlayId} actions={actions}
          clips={clips} selectedClipIds={selectedClipIds}
        />

        {!isMobile && (
          <div
            className={`editor-resizer${resizeDrag ? ' is-dragging' : ''}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              setResizeDrag({ startX: e.clientX, startWidth: sideWidthPx });
            }}
          />
        )}

        <div className="editor-side" style={{ '--editor-side-w': `${sideWidthPx}px` }}>
          <div className="editor-side-scroll">
            <div className="editor-side-block editor-side-transport">
              <div className="editor-preview-transport">
                <button className="icon-btn" title={L.editor_toStart} onClick={() => actions.seek(0)} disabled={!selectedTrack}>
                  <SkipBack size={14} />
                </button>
                <button className="icon-btn" title={isPlaying ? L.editor_pause : L.editor_play} onClick={isPlaying ? actions.pause : actions.play} disabled={!selectedTrack}>
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <span className="editor-preview-time">
                  {formatTime(playheadMs)} <span>/ {formatTime(timelineMs)}</span>
                </span>
              </div>
              <div className="editor-preview-note">{L.editor_previewDisclaimer}</div>
            </div>

            <div className="editor-side-block editor-side-tools" ref={setToolsSlot} />

            <div className="editor-side-block">
              <div className="suno-panel-title"><Clapperboard size={16} color="#ff9d5c" />{L.editor_audioTrackLabel}</div>
              {tracks.length ? (
                <select
                  className="field" value={videoEdit.mureka_track_id || ''}
                  onChange={(e) => actions.setMurekaTrackId(e.target.value || null)}
                >
                  <option value="">{L.editor_noAudioTrack}</option>
                  {tracks.map((t, i) => (
                    <option key={t.track_id} value={t.track_id}>
                      {`${i + 1}. ${(t.file_path || '').split('/').pop()} (${formatSeconds(t.duration_ms || 0)}s)`}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="editor-side-warn">⚠️ {L.editor_noAudioTrack}</div>
              )}
              {showMismatch && (
                <div className="editor-side-warn">
                  ⚠️ {mismatchMs > 0 ? L.editor_durationMismatchLong : L.editor_durationMismatchShort}
                  {' '}({formatSeconds(totalDurationMs)}s {L.editor_vsAudio} {formatSeconds(selectedTrack.duration_ms)}s)
                </div>
              )}
            </div>

            <div className="editor-side-block editor-side-renders">
              <div className="suno-panel-title" style={{ marginBottom: 8 }}>{L.editor_rendersTitle}</div>
              {!renders.length && <div className="editor-side-dim">{L.editor_renderEmpty}</div>}
              {renders.map((r) => (
                <div key={r.render_id} className="editor-render-row">
                  <video src={mediaUrl(`projects/${project.id}/${r.file_path}`)} controls />
                  <div className="editor-render-meta">
                    {r.kind === 'test' && <span className="editor-render-badge">{L.editor_testRenderBadge}</span>}
                    {new Date(r.created_at).toLocaleString()} · {formatSeconds(r.duration_ms)}s · {r.clip_count} {L.editor_clipsCountLabel}
                    {r.range && ` · ${formatTime(r.range.start_ms)}–${formatTime(r.range.end_ms)}`}
                  </div>
                  <div className="editor-render-actions">
                    <button className="icon-btn" title={L.editor_renderDownload} onClick={() => actions.downloadRender(r)}>
                      <Download size={14} />
                    </button>
                    <button className="icon-btn icon-btn-danger" title={L.editor_renderDelete} onClick={() => actions.deleteRender(r.render_id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="editor-side-block">
              <span className="tl-inspector-label tl-inspector-row">
                <span className="tl-inspector-rowlabel">{L.editor_canvasSizeLabel}</span>
                <span className="tl-timecode">{canvasSize.width}×{canvasSize.height}</span>
              </span>
              <div className="tl-inspector-row tl-transition-types">
                <button
                  type="button" className={`tl-transition-chip${canvasOrientation === 'auto' ? ' is-selected' : ''}`}
                  onClick={() => actions.setCanvasOrientation('auto')}
                >
                  {L.editor_canvasOrientationAuto}
                </button>
                <button
                  type="button" className={`tl-transition-chip${canvasOrientation === 'portrait' ? ' is-selected' : ''}`}
                  onClick={() => actions.setCanvasOrientation('portrait')}
                >
                  {L.editor_canvasOrientationPortrait}
                </button>
                <button
                  type="button" className={`tl-transition-chip${canvasOrientation === 'landscape' ? ' is-selected' : ''}`}
                  onClick={() => actions.setCanvasOrientation('landscape')}
                >
                  {L.editor_canvasOrientationLandscape}
                </button>
              </div>
            </div>
          </div>

          <div className="editor-side-footer">
            {!renderLoading && renderError && <div className="editor-side-error">⚠️ {renderError}</div>}
            <div className="editor-side-footer-buttons">
              <button
                className="btn btn-ghost" onClick={() => setTestRangeModalOpen(true)}
                disabled={!canRender || renderLoading}
              >
                {renderLoading ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
                {renderLoading ? L.editor_renderElapsed.replace('{s}', elapsedSeconds) : L.editor_testRenderButton}
              </button>
              <button className="btn btn-gradient" onClick={() => actions.startRender({})} disabled={!canRender || renderLoading}>
                {renderLoading ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
                {renderLoading ? L.editor_renderElapsed.replace('{s}', elapsedSeconds) : L.editor_renderButton}
              </button>
            </div>
          </div>
        </div>
      </div>

      <EditorTimeline
        L={L} projectId={project.id} scenes={scenes} clips={clips} overlays={overlays} totalDurationMs={totalDurationMs}
        selectedTrack={selectedTrack} playheadMs={playheadMs} isPlaying={isPlaying}
        selectedClipIds={selectedClipIds} selectedOverlayId={selectedOverlayId}
        selectedTransitionClipId={selectedTransitionClipId}
        titleCardVariants={titleCardVariants} logos={logos} overlayVideoSources={overlayVideoSources}
        actions={actions} toolsSlotNode={toolsSlot}
        testRange={testRange} onClearTestRange={() => setTestRange(null)}
        onOpenShortcuts={() => setShortcutsOpen(true)} canUndo={canUndo} canRedo={canRedo}
      />

      {shortcutsOpen && <KeyboardShortcutsModal L={L} onClose={() => setShortcutsOpen(false)} />}
      {testRangeModalOpen && (
        <TestRangeModal
          L={L}
          initialStartMs={testRange?.startMs ?? 0}
          initialEndMs={testRange?.endMs ?? Math.min(DEFAULT_TEST_RANGE_MS, timelineMs)}
          maxMs={timelineMs}
          onConfirm={confirmTestRange}
          onClose={() => setTestRangeModalOpen(false)}
        />
      )}
    </div>
  );
}

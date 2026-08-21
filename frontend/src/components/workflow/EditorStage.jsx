import { useEffect, useState } from 'react';
import EditorPreview from './EditorPreview.jsx';
import EditorTimeline from './EditorTimeline.jsx';
import EditorSidePanel from './EditorSidePanel.jsx';
import { WAVEFORM_SCALE_MODES } from './EditorClipSettingsTab.jsx';
import KeyboardShortcutsModal from './KeyboardShortcutsModal.jsx';
import TestRangeModal from './TestRangeModal.jsx';
import { resolveCanvasSize } from '../../lib/canvasOrientation.js';
import { useAudioPeaks } from '../../hooks/useAudioPeaks.js';

const SIDE_WIDTH_STORAGE_KEY = 'editorSideWidthPx';
const DEFAULT_SIDE_WIDTH = 320;
const MIN_SIDE_WIDTH = 240;
const MAX_SIDE_WIDTH = 560;
const TEST_RANGE_STORAGE_KEY_PREFIX = 'editorTestRange_';
const DEFAULT_TEST_RANGE_MS = 10000;
const WAVEFORM_SCALE_STORAGE_KEY = 'editorWaveformScale';
const WAVEFORM_COLOR_STORAGE_KEY = 'editorWaveformColorByFreq';
const TIMELINE_SNAP_STORAGE_KEY = 'editorTimelineSnap';
const TIMELINE_HEIGHT_STORAGE_KEY = 'editorTimelineHeightPx';
const DEFAULT_TIMELINE_HEIGHT = 210;
const MIN_TIMELINE_HEIGHT = 150;
const MAX_TIMELINE_HEIGHT = 620;

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

function loadStoredWaveformScale() {
  try {
    const stored = localStorage.getItem(WAVEFORM_SCALE_STORAGE_KEY);
    return WAVEFORM_SCALE_MODES.includes(stored) ? stored : 'linear';
  } catch {
    return 'linear';
  }
}

function loadStoredWaveformColor() {
  try {
    return localStorage.getItem(WAVEFORM_COLOR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

// Snapping defaults to on, like CapCut's own Track Magnet - only an explicit
// 'false' turns it off, so a first-time user gets the sticky behaviour.
function loadStoredSnap() {
  try {
    return localStorage.getItem(TIMELINE_SNAP_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function loadStoredTimelineHeight() {
  try {
    const stored = Number(localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clamp(stored, MIN_TIMELINE_HEIGHT, MAX_TIMELINE_HEIGHT)
      : DEFAULT_TIMELINE_HEIGHT;
  } catch {
    return DEFAULT_TIMELINE_HEIGHT;
  }
}

/** Editor stage - the final step: assembles the project's picked scene
 * video clips into one rendered file, synced to the project's selected
 * Mureka track. Laid out like a real NLE app, not a scrolling page: the
 * program monitor fills whatever height is left after the timeline
 * (EditorTimeline.jsx, docked to the very bottom); every control that isn't
 * the monitor or the timeline's own ruler/clip/waveform rows lives in the
 * right-hand panel, a 3-tab shell (EditorSidePanel.jsx: object properties /
 * clip settings / finished renders) plus its own bottom icon toolbar. Nothing
 * but `EditorTimeline.jsx` itself ever sits directly under the program
 * monitor - the timeline's own toolbar (zoom, add-scene/overlay pickers)
 * portals into a target `EditorSidePanel.jsx`'s "Клип" tab renders
 * (`toolsSlot`/`onToolsSlotRef` below; that tab stays mounted-but-hidden
 * across tab switches so the portal target never disappears), rather than a
 * strip between the monitor and the timeline. Playback transport is a
 * floating overlay on the program monitor itself
 * (EditorPreview.jsx -> EditorFloatingTransport.jsx). See useEditorStage.js
 * for the state/preview-engine design; this component is layout only. */
export default function EditorStage({
  L, project, isMobile, videoEdit, clips, overlays, overlayVideoSources, markers, audioSettings, exportSettings,
  totalDurationMs, selectedTrack, tracks,
  playheadMs, isPlaying, renderLoading, renderError, elapsedSeconds, selectedClipIds,
  selectedOverlayId, selectedTransitionClipId, isAudioSelected,
  logos, videoRef, audioRef, canUndo, canRedo, actions,
}) {
  const [toolsSlot, setToolsSlot] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sideWidthPx, setSideWidthPx] = useState(loadStoredSideWidth);
  const [resizeDrag, setResizeDrag] = useState(null);
  // A viewing preference for TimelineAudioTrack.jsx's waveform bars, not
  // part of the EDL (see EditorClipSettingsTab.jsx's own comment) -
  // persisted the same way `sideWidthPx` is.
  const [waveformScale, setWaveformScale] = useState(loadStoredWaveformScale);
  // Whether TimelineAudioTrack.jsx tints bars by bass/mid/treble energy
  // share instead of the flat accent color - same kind of viewing
  // preference as waveformScale, persisted the same way.
  const [colorByFrequency, setColorByFrequency] = useState(loadStoredWaveformColor);
  // Timeline magnet (lib/timelineSnap.js) and the timeline panel's own
  // height - both viewing/interaction preferences rather than part of the
  // EDL, persisted exactly like `sideWidthPx` above.
  const [snapEnabled, setSnapEnabled] = useState(loadStoredSnap);
  const [timelineHeightPx, setTimelineHeightPx] = useState(loadStoredTimelineHeight);
  const [timelineResizeDrag, setTimelineResizeDrag] = useState(null);
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

  useEffect(() => {
    try { localStorage.setItem(WAVEFORM_SCALE_STORAGE_KEY, waveformScale); } catch { /* ignore */ }
  }, [waveformScale]);

  useEffect(() => {
    try { localStorage.setItem(WAVEFORM_COLOR_STORAGE_KEY, String(colorByFrequency)); } catch { /* ignore */ }
  }, [colorByFrequency]);

  useEffect(() => {
    try { localStorage.setItem(TIMELINE_SNAP_STORAGE_KEY, String(snapEnabled)); } catch { /* ignore */ }
  }, [snapEnabled]);

  useEffect(() => {
    try { localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(timelineHeightPx)); } catch { /* ignore */ }
  }, [timelineHeightPx]);

  // Same pointer-capture pattern as the side-panel resizer above, only
  // vertical: dragging up grows the timeline and the program monitor gives up
  // the height, since `.editor-layout` is the flexible row above it.
  useEffect(() => {
    if (!timelineResizeDrag) return undefined;
    function onMove(e) {
      setTimelineHeightPx(clamp(
        timelineResizeDrag.startHeight - (e.clientY - timelineResizeDrag.startY),
        MIN_TIMELINE_HEIGHT,
        MAX_TIMELINE_HEIGHT,
      ));
    }
    function onUp() {
      setTimelineResizeDrag(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [timelineResizeDrag]);

  const scenes = project.scenes || [];
  const titleCardVariants = project.title_card?.variants || [];
  const canRender = clips.length > 0 && !!selectedTrack;
  const timelineMs = Math.max(totalDurationMs, selectedTrack?.duration_ms || 0);
  const canvasOrientation = videoEdit.canvas_orientation || 'auto';
  const canvasSize = resolveCanvasSize(clips, scenes, canvasOrientation);
  // One decode per track for the whole stage - the waveform draws from it and
  // `lib/beats.js` reads its bass envelope for the beat-marker button, so it
  // is lifted here rather than owned by TimelineAudioTrack.jsx as it once was.
  const audioPeaks = useAudioPeaks(project.id, selectedTrack);

  return (
    <div className={`editor-stage${isMobile ? ' is-mobile' : ''}${isFullscreen ? ' editor-fullscreen' : ''}`}>
      <div className={`editor-layout${isMobile ? ' is-mobile' : ''}`}>
        <EditorPreview
          L={L} videoRef={videoRef} audioRef={audioRef} projectId={project.id} selectedTrack={selectedTrack}
          overlays={overlays} playheadMs={playheadMs} timelineMs={timelineMs} isPlaying={isPlaying}
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
          <EditorSidePanel
            L={L} projectId={project.id} videoEdit={videoEdit} clips={clips} scenes={scenes} overlays={overlays}
            overlayVideoSources={overlayVideoSources} titleCardVariants={titleCardVariants} logos={logos}
            selectedClipIds={selectedClipIds} selectedOverlayId={selectedOverlayId}
            selectedTransitionClipId={selectedTransitionClipId} isAudioSelected={isAudioSelected}
            audioSettings={audioSettings} exportSettings={exportSettings}
            tracks={tracks} selectedTrack={selectedTrack} totalDurationMs={totalDurationMs}
            canvasOrientation={canvasOrientation} canvasSize={canvasSize}
            actions={actions} canUndo={canUndo} canRedo={canRedo}
            renderLoading={renderLoading} renderError={renderError} elapsedSeconds={elapsedSeconds} canRender={canRender}
            onOpenTestRangeModal={() => setTestRangeModalOpen(true)}
            waveformScale={waveformScale} onSetWaveformScale={setWaveformScale}
            colorByFrequency={colorByFrequency} onToggleColorByFrequency={setColorByFrequency}
            onToolsSlotRef={setToolsSlot}
          />
        </div>
      </div>

      {!isMobile && (
        <div
          className={`editor-timeline-resizer${timelineResizeDrag ? ' is-dragging' : ''}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            setTimelineResizeDrag({ startY: e.clientY, startHeight: timelineHeightPx });
          }}
        />
      )}

      <EditorTimeline
        L={L} projectId={project.id} scenes={scenes} clips={clips} overlays={overlays} markers={markers}
        totalDurationMs={totalDurationMs}
        selectedTrack={selectedTrack} playheadMs={playheadMs} isPlaying={isPlaying}
        selectedClipIds={selectedClipIds} selectedOverlayId={selectedOverlayId}
        selectedTransitionClipId={selectedTransitionClipId} isAudioSelected={isAudioSelected}
        titleCardVariants={titleCardVariants} logos={logos} overlayVideoSources={overlayVideoSources}
        actions={actions} toolsSlotNode={toolsSlot} waveformScale={waveformScale} colorByFrequency={colorByFrequency}
        audioPeaks={audioPeaks} snapEnabled={snapEnabled} onToggleSnap={setSnapEnabled}
        heightPx={isMobile ? undefined : timelineHeightPx}
        testRange={testRange} onClearTestRange={() => setTestRange(null)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
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

import { useEffect, useRef, useState } from 'react';
import EditorObjectPropertiesTab from './EditorObjectPropertiesTab.jsx';
import EditorClipSettingsTab from './EditorClipSettingsTab.jsx';
import EditorRendersTab from './EditorRendersTab.jsx';
import EditorBottomToolbar from './EditorBottomToolbar.jsx';

const TABS = ['properties', 'clip', 'renders'];

function selectionKey(selectedClipIds, selectedOverlayId, selectedTransitionClipId) {
  if (selectedOverlayId) return `overlay:${selectedOverlayId}`;
  if (selectedTransitionClipId) return `transition:${selectedTransitionClipId}`;
  if (selectedClipIds.size) return `clip:${Array.from(selectedClipIds).sort().join(',')}`;
  return 'none';
}

/** The Editor stage's right-hand panel, CapCut-style: 3 tabs (object
 * properties / clip settings / finished renders) instead of one tall
 * scrolling stack of blocks, plus the bottom icon toolbar
 * (split/undo/redo/test-render/render). Auto-switches to "properties"
 * whenever the selection changes to something, and to "renders" whenever a
 * render finishes (`videoEdit.renders` grows) - both effects only read
 * useEditorStage.js's existing state, they don't duplicate it. */
export default function EditorSidePanel({
  L, projectId, videoEdit, clips, scenes, overlays, overlayVideoSources, titleCardVariants, logos,
  selectedClipIds, selectedOverlayId, selectedTransitionClipId,
  tracks, selectedTrack, totalDurationMs, canvasOrientation, canvasSize,
  actions, canUndo, canRedo, renderLoading, renderError, elapsedSeconds, canRender,
  onOpenTestRangeModal, waveformScale, onSetWaveformScale, onToolsSlotRef,
}) {
  const [activeTab, setActiveTab] = useState('clip');
  const prevSelectionKeyRef = useRef('none');
  const prevRendersLenRef = useRef((videoEdit.renders || []).length);

  useEffect(() => {
    const key = selectionKey(selectedClipIds, selectedOverlayId, selectedTransitionClipId);
    if (key !== prevSelectionKeyRef.current && key !== 'none') setActiveTab('properties');
    prevSelectionKeyRef.current = key;
  }, [selectedClipIds, selectedOverlayId, selectedTransitionClipId]);

  useEffect(() => {
    const len = (videoEdit.renders || []).length;
    if (len > prevRendersLenRef.current) setActiveTab('renders');
    prevRendersLenRef.current = len;
  }, [videoEdit.renders]);

  const tabLabels = {
    properties: L.editor_tabProperties, clip: L.editor_tabClip, renders: L.editor_rendersTitle,
  };

  return (
    <>
      <div className="editor-tabs">
        {TABS.map((tab) => (
          <button key={tab} className={`chip${activeTab === tab ? ' is-active' : ''}`} onClick={() => setActiveTab(tab)}>
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      <div className="editor-side-scroll">
        {activeTab === 'properties' && (
          <EditorObjectPropertiesTab
            L={L} projectId={projectId} scenes={scenes} clips={clips} overlays={overlays}
            selectedClipIds={selectedClipIds} selectedOverlayId={selectedOverlayId}
            selectedTransitionClipId={selectedTransitionClipId}
            titleCardVariants={titleCardVariants} logos={logos} overlayVideoSources={overlayVideoSources}
            actions={actions}
          />
        )}
        {/* Always mounted (not `activeTab === 'clip' &&`, unlike the other two
            tabs) - it hosts the timeline toolbar's portal target
            (`onToolsSlotRef`, see EditorClipSettingsTab.jsx), which must stay
            in the DOM across tab switches so EditorTimeline.jsx's portal
            never loses its target and falls back to rendering that content
            inline above the timeline again. `display: none` only hides it;
            a portal's children keep working while their container is hidden
            this way, just not while it's unmounted. */}
        <div style={{ display: activeTab === 'clip' ? undefined : 'none' }}>
          <EditorClipSettingsTab
            L={L} videoEdit={videoEdit} tracks={tracks} selectedTrack={selectedTrack}
            totalDurationMs={totalDurationMs} canvasOrientation={canvasOrientation} canvasSize={canvasSize}
            actions={actions} waveformScale={waveformScale} onSetWaveformScale={onSetWaveformScale}
            onToolsSlotRef={onToolsSlotRef}
          />
        </div>
        {activeTab === 'renders' && (
          <EditorRendersTab L={L} projectId={projectId} renders={videoEdit.renders || []} actions={actions} />
        )}
      </div>

      <EditorBottomToolbar
        L={L} actions={actions} canUndo={canUndo} canRedo={canRedo} hasClips={clips.length > 0}
        renderLoading={renderLoading} renderError={renderError} elapsedSeconds={elapsedSeconds} canRender={canRender}
        onOpenTestRangeModal={onOpenTestRangeModal}
      />
    </>
  );
}

import TimelineClipInspector from './TimelineClipInspector.jsx';
import TimelineOverlayInspector from './TimelineOverlayInspector.jsx';
import TimelineTransitionInspector from './TimelineTransitionInspector.jsx';

/** "Свойства объекта" tab: shows whichever of clip / overlay / transition
 * inspector matches the current selection - the same 3-way switch that used
 * to live inline in EditorTimelineTools.jsx, unchanged logic, just relocated
 * into its own tab (see EditorSidePanel.jsx, which auto-switches here on any
 * new selection). */
export default function EditorObjectPropertiesTab({
  L, projectId, scenes, clips, overlays, selectedClipIds, selectedOverlayId, selectedTransitionClipId,
  titleCardVariants, logos, overlayVideoSources, actions,
}) {
  const selectedClip = selectedClipIds.size === 1
    ? clips.find((c) => selectedClipIds.has(c.clip_id)) || null
    : null;
  const selectedScene = selectedClip ? scenes?.[selectedClip.scene_index] : null;
  const selectedSourceMs = selectedClip
    ? ((selectedScene?.videos || []).find((v) => v.video_id === selectedClip.video_id)?.duration_seconds || 0) * 1000
    : 0;
  const selectedOverlay = selectedOverlayId
    ? (overlays || []).find((o) => o.overlay_id === selectedOverlayId) || null
    : null;
  const selectedTransitionClip = selectedTransitionClipId
    ? clips.find((c) => c.clip_id === selectedTransitionClipId) || null
    : null;

  if (selectedOverlayId) {
    return (
      <TimelineOverlayInspector
        L={L} overlay={selectedOverlay} projectId={projectId}
        titleCardVariants={titleCardVariants} logos={logos} overlayVideoSources={overlayVideoSources} actions={actions}
      />
    );
  }
  if (selectedTransitionClipId) {
    return <TimelineTransitionInspector L={L} clip={selectedTransitionClip} actions={actions} />;
  }
  return (
    <TimelineClipInspector
      L={L} clip={selectedClip} scene={selectedScene} sourceDurationMs={selectedSourceMs}
      selectedCount={selectedClipIds.size} selectedClipIds={selectedClipIds} actions={actions}
    />
  );
}

/** Human-readable "N. description" label for a scene - the timeline clip
 * block's hover tooltip (TimelineClipBlock.jsx) and the add-scene chips
 * (EditorTimeline.jsx) both need it. Split out of TimelineClipBlock.jsx so
 * that component file only exports the component itself (react-refresh
 * needs that to fast-refresh cleanly). */
export function sceneLabel(scene, sceneIndex) {
  const text = scene?.scene_description || scene?.lyric_segment || '';
  return `${sceneIndex + 1}. ${text.length > 48 ? `${text.slice(0, 48)}…` : text}`;
}

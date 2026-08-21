import { mediaUrl } from '../../api/client.js';
import { MIN_SLOT_PX, useClipThumbnails } from '../../hooks/useClipThumbnails.js';
import { sceneLabel } from '../../lib/editorClipLabel.js';

function sceneThumb(scene) {
  const image = (scene?.images || []).find((img) => img.is_selected) || (scene?.images || [])[0];
  return image?.file_path || null;
}

/** One block on the timeline's video row - shown as real frames from *this*
 * clip's own trimmed window (`useClipThumbnails`, one or more depending on
 * how wide the block renders) instead of the scene number/description text
 * EditorTimeline.jsx used to overlay. The scene's static image is still
 * drawn underneath as `backgroundImage` so the block isn't blank while the
 * real frames are still decoding. Pulled out of EditorTimeline.jsx's
 * `clips.map(...)` because a hook can't be called from inside a loop. */
export default function TimelineClipBlock({
  clip, scene, projectId, selectedClipIds, isDragging, left, width,
  onBlockPointerDown, onTrimStartPointerDown, onTrimEndPointerDown, onKeyDown, onContextMenu, nodeRef,
}) {
  const video = (scene?.videos || []).find((v) => v.video_id === clip.video_id);
  const frames = useClipThumbnails({
    projectId, video, trimStartMs: clip.trimStartMs, trimEndMs: clip.trimEndMs, widthPx: width,
  });
  const staticThumb = sceneThumb(scene);
  const isLoading = !frames.length && width >= MIN_SLOT_PX;

  return (
    <div
      ref={nodeRef}
      className={`tl-clip${selectedClipIds.has(clip.clip_id) ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}${isLoading ? ' is-loading' : ''}`}
      style={{
        left,
        width,
        backgroundImage: staticThumb ? `url(${mediaUrl(`projects/${projectId}/${staticThumb}`)})` : undefined,
      }}
      onPointerDown={onBlockPointerDown}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      title={sceneLabel(scene, clip.scene_index)}
      role="button"
      tabIndex={0}
    >
      <span className="tl-clip-handle tl-clip-handle-start" onPointerDown={onTrimStartPointerDown} />
      {!!frames.length && (
        <div className="tl-clip-thumbs">
          {frames.map((src, i) => (
            // eslint-disable-next-line react/no-array-index-key -- frames are positional samples, not a stable-identity list
            <div key={i} className="tl-clip-thumb" style={{ backgroundImage: `url(${src})` }} />
          ))}
        </div>
      )}
      {(clip.speed || 1) !== 1 && <span className="tl-clip-speed">{clip.speed}×</span>}
      <span className="tl-clip-handle tl-clip-handle-end" onPointerDown={onTrimEndPointerDown} />
    </div>
  );
}

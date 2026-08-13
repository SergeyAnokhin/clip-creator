import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { clampTrim, resolveTrimEndMs } from '../../lib/timeline.js';

function sceneLabel(scene, sceneIndex) {
  const text = scene?.scene_description || scene?.lyric_segment || '';
  const trimmed = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return `${sceneIndex + 1}. ${trimmed}`;
}

function sceneThumb(scene) {
  const image = (scene?.images || []).find((img) => img.is_selected) || (scene?.images || [])[0];
  return image?.file_path || null;
}

/** One row per timeline clip: which scene/video it comes from, trim (in/out,
 * plain seconds fields - simpler than ReferenceAudioTrimmer.jsx's full
 * per-clip canvas widget, sufficient for v1's reorder/trim/speed scope),
 * speed, reorder (▲/▼ - no drag-and-drop dependency, see
 * useEditorStage.js's docstring), remove. Below the list, scenes not yet on
 * the timeline can be added back in. */
export default function EditorTimeline({ L, projectId, scenes, clips, actions }) {
  const usedSceneIndices = new Set(clips.map((c) => c.scene_index));
  const addableScenes = (scenes || [])
    .map((scene, sceneIndex) => ({ scene, sceneIndex }))
    .filter(({ scene, sceneIndex }) => !usedSceneIndices.has(sceneIndex) && (scene.videos || []).length > 0);

  function addScene(scene, sceneIndex) {
    const video = (scene.videos || []).find((v) => v.is_selected) || scene.videos[0];
    actions.addSceneClip(sceneIndex, video.video_id);
  }

  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div className="suno-panel-title">{L.editor_timelineTitle}</div>

      {!clips.length && (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.editor_timelineEmpty}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {clips.map((clip, idx) => {
          const scene = scenes?.[clip.scene_index];
          const videos = scene?.videos || [];
          const video = videos.find((v) => v.video_id === clip.video_id);
          const sourceDurationMs = (video?.duration_seconds || 0) * 1000;
          const trimStartMs = clip.trim_start_ms || 0;
          const trimEndMs = resolveTrimEndMs(clip, sourceDurationMs);
          const thumb = sceneThumb(scene);

          function commitTrim(nextStartMs, nextEndMs) {
            // Nothing to clamp *against* for an imported/uploaded clip with
            // no known duration (sourceDurationMs 0) - just keep start >= 0
            // and end > start, same floor clampTrim uses.
            if (sourceDurationMs > 0) {
              const { trimStartMs: s, trimEndMs: e } = clampTrim(nextStartMs, nextEndMs, sourceDurationMs);
              actions.setClipTrim(clip.clip_id, s, e);
            } else {
              const s = Math.max(0, nextStartMs);
              const e = Math.max(s + 100, nextEndMs);
              actions.setClipTrim(clip.clip_id, s, e);
            }
          }

          return (
            <div key={clip.clip_id} className="glass-card" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10 }}>
              <div style={{ width: 64, height: 64, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.05)' }}>
                {thumb && <img src={mediaUrl(`projects/${projectId}/${thumb}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>{sceneLabel(scene, clip.scene_index)}</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select
                    className="field" style={{ fontSize: 12, padding: '3px 6px' }}
                    value={clip.video_id} onChange={(e) => actions.changeClipVideo(clip.clip_id, e.target.value)}
                  >
                    {videos.map((v, i) => (
                      <option key={v.video_id} value={v.video_id}>{`${L.editor_clipVideoOption} ${i + 1} (${v.duration_seconds || '?'}s)`}</option>
                    ))}
                  </select>

                  <label style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                    {L.editor_clipTrimLabel}:
                    <input
                      type="number" step="0.1" min={0} {...(sourceDurationMs > 0 ? { max: (sourceDurationMs / 1000).toFixed(1) } : {})}
                      value={(trimStartMs / 1000).toFixed(1)}
                      onChange={(e) => commitTrim(Number(e.target.value) * 1000, trimEndMs)}
                      style={{ width: 56, marginLeft: 4, marginRight: 4 }} className="field"
                    />
                    →
                    <input
                      type="number" step="0.1" min={0} {...(sourceDurationMs > 0 ? { max: (sourceDurationMs / 1000).toFixed(1) } : {})}
                      value={(trimEndMs / 1000).toFixed(1)}
                      onChange={(e) => commitTrim(trimStartMs, Number(e.target.value) * 1000)}
                      style={{ width: 56, marginLeft: 4 }} className="field"
                    />
                  </label>
                  {!sourceDurationMs && (
                    <span style={{ fontSize: 11, color: '#fbbf24' }}>⚠ {L.editor_unknownDuration}</span>
                  )}

                  <label style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                    {L.editor_clipSpeedLabel}:
                    <input
                      type="number" step="0.25" min="0.25" max="4"
                      value={clip.speed || 1}
                      onChange={(e) => actions.setClipSpeed(clip.clip_id, Math.max(0.25, Number(e.target.value) || 1))}
                      style={{ width: 52, marginLeft: 4 }} className="field"
                    />×
                  </label>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <button className="icon-btn" title={L.editor_clipMoveUp} disabled={idx === 0} onClick={() => actions.moveClipUp(clip.clip_id)}>
                  <ChevronUp size={14} />
                </button>
                <button className="icon-btn" title={L.editor_clipMoveDown} disabled={idx === clips.length - 1} onClick={() => actions.moveClipDown(clip.clip_id)}>
                  <ChevronDown size={14} />
                </button>
              </div>
              <button className="icon-btn" title={L.editor_clipRemove} onClick={() => actions.removeClip(clip.clip_id)}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {!!addableScenes.length && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>{L.editor_addSceneLabel}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {addableScenes.map(({ scene, sceneIndex }) => (
              <button
                key={sceneIndex} className="btn-ghost"
                style={{ border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}
                onClick={() => addScene(scene, sceneIndex)}
              >
                <Plus size={12} /> {sceneLabel(scene, sceneIndex)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

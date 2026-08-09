import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Star, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { formatCost } from '../../lib/pricing.js';

const _PROVIDER_TAG = { google: 'Google', google_free: 'Google Free', openrouter: 'OpenRouter' };

function modelLabel(model) {
  if (!model) return '';
  const [provider, ...rest] = model.split(':');
  return `[${_PROVIDER_TAG[provider] || provider}] ${rest.join(':')}`;
}

/** Single-video "hero" preview for a scene's `videos` array - mirrors
 * ImageCarousel.jsx's shape (fills its container edge-to-edge, prev/next
 * arrows + counter, delete/select-main/star overlays on the frame itself)
 * but for `<video>` instead of `<img>`, plus a caption strip underneath
 * showing which model made it, what it cost, and how long generation took -
 * the user explicitly asked for the model to always be obvious per video,
 * unlike images (where the model is only visible in the lightbox). No crop/
 * upload/drag-drop here - not offered for generated video. */
export default function VideoCarousel({ L, projectId, videos, currentIndex, onIndexChange, onDelete, onSelectMain, onRate }) {
  const [broken, setBroken] = useState(false);
  const total = videos.length;
  const video = total ? videos[Math.min(currentIndex, total - 1)] : null;
  const showVideo = Boolean(video?.file_path) && !broken;

  function go(delta) {
    if (total < 2) return;
    setBroken(false);
    onIndexChange((currentIndex + delta + total) % total);
  }

  return (
    <div className="image-carousel is-fill">
      <div className={`image-carousel-frame${video?.is_selected ? ' is-main' : ''}`}>
        {showVideo ? (
          <video
            key={video.video_id}
            src={mediaUrl(`projects/${projectId}/${video.file_path}`)}
            controls
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <span className="image-carousel-placeholder">{L.video_noneYet}</span>
        )}

        {total > 1 && (
          <>
            <button className="image-carousel-nav image-carousel-nav-prev" onClick={(e) => { e.stopPropagation(); go(-1); }}>
              <ChevronLeft size={15} />
            </button>
            <button className="image-carousel-nav image-carousel-nav-next" onClick={(e) => { e.stopPropagation(); go(1); }}>
              <ChevronRight size={15} />
            </button>
            <span className="image-carousel-counter">{currentIndex + 1} / {total}</span>
          </>
        )}

        {showVideo && (
          <button
            className={`image-thumb-select${video.is_selected ? ' is-active' : ''}`}
            title={L.selectAsMainTitle}
            onClick={(e) => { e.stopPropagation(); onSelectMain(); }}
          >
            <Check size={12} />
          </button>
        )}
        {showVideo && (
          <button className="image-thumb-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <Trash2 size={11} />
          </button>
        )}
        {showVideo && (
          <div className="image-carousel-stars" onClick={(e) => e.stopPropagation()}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => onRate(n)}>
                <Star size={13} color={n <= video.rating ? '#ff9d5c' : 'rgba(255,255,255,0.35)'} />
              </button>
            ))}
          </div>
        )}
      </div>

      {showVideo && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 8 }}>
          <span title={L.video_modelTitle}>🎬 {modelLabel(video.model)}</span>
          <span title={L.video_costTitle}>💰 {formatCost(video.cost)}</span>
          {video.generation_ms != null && (
            <span title={L.video_generationTimeTitle}>⏱ {(video.generation_ms / 1000).toFixed(0)}{L.suno_unitSeconds}</span>
          )}
          {video.duration_seconds != null && <span title={L.video_durationTitle}>🎞 {video.duration_seconds}{L.suno_unitSeconds}</span>}
        </div>
      )}
    </div>
  );
}

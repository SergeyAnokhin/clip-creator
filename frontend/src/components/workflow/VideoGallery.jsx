import { useRef, useState } from 'react';
import { Check, Star, Trash2, ZoomIn } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { formatCost } from '../../lib/pricing.js';

const _PROVIDER_TAG = { google: 'Google', google_free: 'Google Free', openrouter: 'OpenRouter' };

const _MIN_TILE_SIZE = 220;
const _MAX_TILE_SIZE = 640;
const _DEFAULT_TILE_SIZE = 340;

function modelLabel(model) {
  if (!model) return '';
  const [provider, ...rest] = model.split(':');
  return `[${_PROVIDER_TAG[provider] || provider}] ${rest.join(':')}`;
}

/** Grid of every candidate video for the current scene shown at once
 * (reuses `TitleCardGallery.jsx`'s overlay-control classes but its own
 * `.video-gallery` grid, not `.titlecard-gallery` - the column width needs
 * to be per-instance adjustable via `tileSize` below, which a shared class
 * can't do without also resizing Title Card/poster grids) instead of
 * `VideoCarousel.jsx`'s old one-at-a-time prev/next+counter view - the user
 * explicitly didn't want to page through clips to compare them, and wanted
 * the cells themselves bigger than `TitleCardGallery`'s fixed 220px, with a
 * way to size them up further. A slider under the grid (`tileSize`, plain
 * component state - resets on remount, not worth persisting) sets the
 * `--video-gallery-tile` CSS var each cell's `aspect-ratio`-boxed frame
 * grows from, so bumping it up keeps every clip's own aspect ratio intact
 * instead of stretching/cropping. Each cell previews silently on hover
 * (muted, looping) rather than needing a click to start playback; clicking
 * the clip itself toggles play/pause in place (there's nothing to navigate
 * to - every candidate is already on screen), separate from the
 * select-main/delete/star overlay buttons which stop propagation so they
 * don't also toggle playback. */
export default function VideoGallery({ L, projectId, videos, onDelete, onSelectMain, onRate }) {
  const [tileSize, setTileSize] = useState(_DEFAULT_TILE_SIZE);

  return (
    <>
      <div className="video-gallery" style={{ '--video-gallery-tile': `${tileSize}px` }}>
        {videos.map((video, i) => (
          <VideoTile
            key={video.video_id}
            L={L} projectId={projectId} video={video}
            onDelete={() => onDelete(i)}
            onSelectMain={() => onSelectMain(i)}
            onRate={(rating) => onRate(i, rating)}
          />
        ))}
      </div>
      <label className="video-gallery-zoom">
        <ZoomIn size={14} color="var(--text-faint)" />
        <span>{L.video_gallerySizeLabel}</span>
        <input
          type="range" min={_MIN_TILE_SIZE} max={_MAX_TILE_SIZE} step={20} value={tileSize}
          onChange={(e) => setTileSize(Number(e.target.value))}
          style={{ accentColor: '#ff9d5c' }}
        />
      </label>
    </>
  );
}

// `video.aspect_ratio` is the *requested* generation param - null for
// uploads, and even when set (`'16:9'`/`'9:16'`/`'1:1'`) a provider can still
// return a clip that doesn't exactly match it. The frame's box must match
// the clip's real pixel dimensions or `object-fit: contain` letterboxes it
// (black bars), so `naturalRatio` (read off the loaded `<video>` itself via
// `videoWidth`/`videoHeight`) always wins once available; the stored
// `aspect_ratio` is only a best-guess placeholder for the brief window
// before metadata loads (`preload="metadata"` makes that near-instant).
function parseAspectRatio(value) {
  if (!value || value === 'auto') return null;
  const [w, h] = value.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

function VideoTile({ L, projectId, video, onDelete, onSelectMain, onRate }) {
  const videoRef = useRef(null);
  const [broken, setBroken] = useState(false);
  const [naturalRatio, setNaturalRatio] = useState(null);
  const showVideo = Boolean(video.file_path) && !broken;
  const frameRatio = naturalRatio || parseAspectRatio(video.aspect_ratio) || 1;

  function handleLoadedMetadata(e) {
    const v = e.target;
    if (v.videoWidth && v.videoHeight) setNaturalRatio(v.videoWidth / v.videoHeight);
  }
  function handleEnter() {
    videoRef.current?.play().catch(() => {});
  }
  function handleLeave() {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  }
  function handleToggle(e) {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  return (
    <div className="titlecard-gallery-item">
      <div
        className={`titlecard-gallery-frame${video.is_selected ? ' is-main' : ''}`}
        style={{ aspectRatio: frameRatio }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {showVideo ? (
          <video
            ref={videoRef}
            src={mediaUrl(`projects/${projectId}/${video.file_path}`)}
            muted
            loop
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onError={() => setBroken(true)}
            onClick={handleToggle}
          />
        ) : (
          <span className="image-carousel-placeholder">{L.video_noneYet}</span>
        )}
        <button
          className={`image-thumb-select${video.is_selected ? ' is-active' : ''}`}
          title={L.selectAsMainTitle}
          onClick={(e) => { e.stopPropagation(); onSelectMain(); }}
        >
          <Check size={12} />
        </button>
        <button className="image-thumb-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <Trash2 size={11} />
        </button>
        <div className="image-carousel-stars" role="presentation" onClick={(e) => e.stopPropagation()}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => onRate(n)}>
              <Star size={12} color={n <= video.rating ? '#ff9d5c' : 'rgba(255,255,255,0.35)'} />
            </button>
          ))}
        </div>
      </div>
      <div className="titlecard-gallery-caption">
        <div title={L.video_modelTitle}>🎬 {modelLabel(video.model)}</div>
        <div>
          <span title={L.video_costTitle}>💰 {formatCost(video.cost)}</span>
          {video.generation_ms != null && <span title={L.video_generationTimeTitle}> · ⏱ {(video.generation_ms / 1000).toFixed(0)}{L.suno_unitSeconds}</span>}
          {video.duration_seconds != null && <span title={L.video_durationTitle}> · 🎞 {video.duration_seconds}{L.suno_unitSeconds}</span>}
        </div>
      </div>
    </div>
  );
}

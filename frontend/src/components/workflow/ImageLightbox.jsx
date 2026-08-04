import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { formatCost } from '../../lib/pricing.js';

/** Click-to-enlarge modal for a scene's `images` array, plus (when the
 * current image carries them - see images.py's `_run_job`) a row of
 * technical metadata: model, cost, requested aspect ratio and actual pixel
 * resolution. Resolution isn't stored server-side (no Pillow dependency in
 * the backend - see images.py) - it's read off the already-loaded `<img>`
 * element instead. Controlled by the caller (pass `images: []` / omit
 * rendering to close) - kept as a dumb presentational component so
 * SceneTextCard.jsx (Scenes stage), SceneCard.jsx (Images stage) and
 * ImagesStage.jsx's reference-image thumbs can all reuse it without any
 * shared state; callers with just one image (references) pass a single-item
 * array. Portaled to document.body (like TranslateButton.jsx) since it's
 * mounted inside a `.glass-card`, whose `backdrop-filter` would otherwise
 * turn it into the containing block for our `position: fixed` backdrop and
 * clip the lightbox to that card instead of the viewport. */
export default function ImageLightbox({ L, projectId, images, initialIndex = 0, onClose }) {
  const [naturalSize, setNaturalSize] = useState(null);
  const [index, setIndex] = useState(initialIndex);
  const open = !!images?.length;

  useEffect(() => {
    if (open) {
      setIndex(initialIndex);
      setNaturalSize(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || images.length < 2) return undefined;
    function onKeyDown(e) {
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, images.length, index]);

  if (!open) return null;

  function go(delta) {
    setNaturalSize(null);
    setIndex((i) => (i + delta + images.length) % images.length);
  }

  const image = images[index];
  const hasMeta = image.model || image.cost != null || image.aspect_ratio || naturalSize;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span />
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div style={{ position: 'relative' }}>
          <img
            className="lightbox-image"
            src={mediaUrl(`projects/${projectId}/${image.file_path}`)}
            alt=""
            onLoad={(e) => setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
          />
          {images.length > 1 && (
            <>
              <button className="image-carousel-nav image-carousel-nav-prev" onClick={() => go(-1)}>
                <ChevronLeft size={16} />
              </button>
              <button className="image-carousel-nav image-carousel-nav-next" onClick={() => go(1)}>
                <ChevronRight size={16} />
              </button>
              <span className="image-carousel-counter">{index + 1} / {images.length}</span>
            </>
          )}
        </div>
        {hasMeta && (
          <div className="lightbox-meta">
            {image.model && <span><span className="lightbox-meta-label">{L.lightboxModel}:</span> {image.model}</span>}
            {image.cost != null && <span><span className="lightbox-meta-label">{L.lightboxCost}:</span> {formatCost(image.cost)}</span>}
            {image.aspect_ratio && <span><span className="lightbox-meta-label">{L.lightboxAspectRatio}:</span> {image.aspect_ratio}</span>}
            {naturalSize && <span><span className="lightbox-meta-label">{L.lightboxResolution}:</span> {naturalSize.w}×{naturalSize.h}</span>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

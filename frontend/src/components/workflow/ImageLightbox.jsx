import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { formatCost } from '../../lib/pricing.js';

/** Click-to-enlarge modal for a single generated scene image, plus (when the
 * image carries them - see images.py's `_run_job`) a row of technical
 * metadata: model, cost, requested aspect ratio and actual pixel resolution.
 * Resolution isn't stored server-side (no Pillow dependency in the backend -
 * see images.py) - it's read off the already-loaded `<img>` element instead.
 * Controlled by the caller (pass `image: null` / omit rendering to close) -
 * kept as a dumb presentational component so SceneTextCard.jsx (Scenes
 * stage), SceneCard.jsx/ImageThumb.jsx and ImagesStage.jsx's reference-image
 * thumbs (Images stage) can all reuse it without any shared state. Portaled
 * to document.body (like TranslateButton.jsx) since it's mounted inside a
 * `.glass-card`, whose `backdrop-filter` would otherwise turn it into the
 * containing block for our `position: fixed` backdrop and clip the lightbox
 * to that card instead of the viewport. */
export default function ImageLightbox({ L, projectId, image, onClose }) {
  const [naturalSize, setNaturalSize] = useState(null);
  if (!image) return null;

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
        <img
          className="lightbox-image"
          src={mediaUrl(`projects/${projectId}/${image.file_path}`)}
          alt=""
          onLoad={(e) => setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
        />
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

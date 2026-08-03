import { useState } from 'react';
import { Check, Star, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

function variantLabel(image) {
  const match = /var_(\d+)/.exec(image.file_path || '');
  return match ? `Вариант ${match[1]}` : image.image_id || '';
}

/** Grid thumbnail for one generated scene image (Images stage). Clicking the
 * frame opens the fullscreen lightbox (the default/expected action); picking
 * this variant as the scene's main image is a separate explicit button (top
 * right, was a passive checkmark badge before) so the two don't fight over
 * the same click. The frame's aspect ratio is measured off the loaded image
 * itself (not the requested `image.aspect_ratio`, which older images don't
 * even have) so portrait/landscape variants get their own box instead of
 * being force-cropped into a fixed square. */
export default function ImageThumb({ L, projectId, image, onSelectMain, onRate, onExpand, onDelete }) {
  const [broken, setBroken] = useState(false);
  const [ratio, setRatio] = useState(null);
  const showImage = Boolean(image.file_path) && !broken;

  return (
    <div className="image-thumb">
      <div
        className={`image-thumb-frame${image.is_selected ? ' is-main' : ''}`}
        style={ratio ? { aspectRatio: ratio } : undefined}
        onClick={showImage ? onExpand : undefined}
      >
        {showImage ? (
          <img
            src={mediaUrl(`projects/${projectId}/${image.file_path}`)}
            alt=""
            onError={() => setBroken(true)}
            onLoad={(e) => setRatio(`${e.target.naturalWidth} / ${e.target.naturalHeight}`)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }}
          />
        ) : (
          variantLabel(image)
        )}
        {showImage && (
          <button
            className={`image-thumb-select${image.is_selected ? ' is-active' : ''}`}
            title={L.selectAsMainTitle}
            onClick={(e) => { e.stopPropagation(); onSelectMain(); }}
          >
            <Check size={12} />
          </button>
        )}
        <button
          className="image-thumb-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 size={11} />
        </button>
      </div>
      <div className="image-thumb-stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => onRate(n)}>
            <Star size={13} color={n <= image.rating ? '#ff9d5c' : 'rgba(255,255,255,0.25)'} />
          </button>
        ))}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Check, Maximize2, Star } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

function variantLabel(image) {
  const match = /var_(\d+)/.exec(image.file_path || '');
  return match ? `Вариант ${match[1]}` : image.image_id || '';
}

export default function ImageThumb({ projectId, image, onSelectMain, onRate, onExpand }) {
  const [broken, setBroken] = useState(false);
  const showImage = Boolean(image.file_path) && !broken;

  return (
    <div className="image-thumb">
      <div className={`image-thumb-frame${image.is_selected ? ' is-main' : ''}`} onClick={onSelectMain}>
        {showImage ? (
          <img
            src={mediaUrl(`projects/${projectId}/${image.file_path}`)}
            alt=""
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }}
          />
        ) : (
          variantLabel(image)
        )}
        {showImage && (
          <button
            className="image-thumb-expand"
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
          >
            <Maximize2 size={11} />
          </button>
        )}
        {image.is_selected && (
          <span className="image-thumb-check">
            <Check size={12} />
          </span>
        )}
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

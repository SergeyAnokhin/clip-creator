import { Check, Star } from 'lucide-react';

export default function ImageThumb({ image, onSelectMain, onRate }) {
  return (
    <div className="image-thumb">
      <div className={`image-thumb-frame${image.main ? ' is-main' : ''}`} onClick={onSelectMain}>
        {image.label}
        {image.main && (
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

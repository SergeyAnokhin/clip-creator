import { Check, Eraser, Loader2, Star, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { formatCost } from '../../lib/pricing.js';

/** Shows every Title Card variant at once (a grid, not a one-at-a-time
 * carousel) so nothing needs to be paged through to compare results.
 * Each cell keeps the variant's own aspect ratio (`object-fit: contain`,
 * never crops) and, unlike the single-image `ImageCarousel.jsx`, prints a
 * caption underneath with the model/cost/base-prompt that produced it -
 * data `title_card.py`'s `_run_job` already persists on every variant, just
 * not previously surfaced anywhere. Clicking a cell opens `ImageLightbox`
 * on that exact variant (the caller owns the lightbox's open index). */
export default function TitleCardGallery({
  L, projectId, variants, onExpand, onDelete, onSelectMain, onRate, onRemoveBackground, removingBgIds,
}) {
  return (
    <div className="titlecard-gallery">
      {variants.map((variant, i) => {
        const [w, h] = (variant.aspect_ratio || '1:1').split(':').map(Number);
        const removingBg = removingBgIds?.has(variant.variant_id);
        return (
          <div className="titlecard-gallery-item" key={variant.variant_id || i}>
            <div
              className={`titlecard-gallery-frame${variant.is_selected ? ' is-main' : ''}`}
              style={{ aspectRatio: `${w || 1} / ${h || 1}` }}
              onClick={() => onExpand(i)}
            >
              <img src={mediaUrl(`projects/${projectId}/${variant.file_path}`)} alt="" />
              <button
                className={`image-thumb-select${variant.is_selected ? ' is-active' : ''}`}
                title={L.selectAsMainTitle}
                onClick={(e) => { e.stopPropagation(); onSelectMain(i); }}
              >
                <Check size={12} />
              </button>
              <button
                className="image-thumb-delete"
                onClick={(e) => { e.stopPropagation(); onDelete(i); }}
              >
                <Trash2 size={11} />
              </button>
              <div className="image-carousel-stars" onClick={(e) => e.stopPropagation()}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => onRate(i, n)}>
                    <Star size={12} color={n <= variant.rating ? '#ff9d5c' : 'rgba(255,255,255,0.35)'} />
                  </button>
                ))}
              </div>
              <button
                className="titlecard-gallery-bg-btn"
                title={L.titleCard_removeBackground}
                disabled={removingBg}
                onClick={(e) => { e.stopPropagation(); onRemoveBackground(i); }}
              >
                {removingBg ? <Loader2 size={12} className="spin" /> : <Eraser size={12} />}
              </button>
            </div>
            <div className="titlecard-gallery-caption">
              <div><strong>{variant.model || '—'}</strong> · {formatCost(variant.cost)}</div>
              {variant.base_prompt && (
                <div className="titlecard-gallery-prompt" title={variant.base_prompt}>{variant.base_prompt}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

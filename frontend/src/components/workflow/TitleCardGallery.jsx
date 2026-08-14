import { useEffect, useRef, useState } from 'react';
import { Check, Eraser, Loader2, Star, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { formatCost } from '../../lib/pricing.js';
import MagicLayersButton from './MagicLayersButton.jsx';

const BG_REMOVE_METHODS = ['local', 'fal', 'replicate'];

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
  onDecomposeMagicLayers, magicLayerGroups = [], magicBusySources,
}) {
  // Which variant's "choose background-removal method" menu is open (see
  // the guide this feature was implemented from: 3 interchangeable methods,
  // picked right when the button is pressed rather than only in Settings).
  // A single index, not a Set, since only one menu can be open at a time.
  const [methodMenuIdx, setMethodMenuIdx] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (methodMenuIdx === null) return undefined;
    function handleOutsideClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMethodMenuIdx(null);
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [methodMenuIdx]);

  const methodLabels = {
    local: L.settings_bgRemoverMethodLocal, fal: L.settings_bgRemoverMethodFal, replicate: L.settings_bgRemoverMethodReplicate,
  };

  function pickMethod(i, method) {
    setMethodMenuIdx(null);
    onRemoveBackground(i, method);
  }

  return (
    <div className="titlecard-gallery">
      {variants.map((variant, i) => {
        const [w, h] = (variant.aspect_ratio || '1:1').split(':').map(Number);
        const removingBg = removingBgIds?.has(variant.variant_id);
        const magicLayerCount = magicLayerGroups
          .filter((g) => g.source_path === variant.file_path)
          .reduce((max, g) => Math.max(max, g.layers?.length || 0), 0);
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
                onClick={(e) => { e.stopPropagation(); setMethodMenuIdx((cur) => (cur === i ? null : i)); }}
              >
                {removingBg ? <Loader2 size={12} className="spin" /> : <Eraser size={12} />}
              </button>
              {methodMenuIdx === i && (
                <div className="titlecard-gallery-bg-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
                  {BG_REMOVE_METHODS.map((method) => (
                    <button key={method} onClick={() => pickMethod(i, method)}>
                      {methodLabels[method]}
                    </button>
                  ))}
                </div>
              )}
              {onDecomposeMagicLayers && (
                <MagicLayersButton
                  L={L}
                  className="titlecard-gallery-bg-btn"
                  style={{ position: 'absolute', left: 34, bottom: 6, zIndex: 2 }}
                  busy={magicBusySources?.has(variant.file_path)}
                  onPick={(method, numLayers) => onDecomposeMagicLayers(variant.file_path, {
                    method, numLayers, sourceKind: 'title_card_variant',
                  })}
                />
              )}
              {magicLayerCount > 0 && (
                <span className="magic-layer-badge" title={L.magic_ready}>{`✨ ${magicLayerCount}`}</span>
              )}
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

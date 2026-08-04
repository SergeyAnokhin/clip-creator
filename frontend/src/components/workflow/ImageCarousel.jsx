import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Star, Trash2, Upload } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

/** Single-image "hero" preview for a scene's `images` array - fills its
 * container edge-to-edge (`.scene-image-panel`, a padding-less sibling block
 * next to the scene's prompt card, not squeezed into a column inside it) so
 * the image gets as much screen space as the layout can spare.
 * `object-fit: contain` keeps portrait/landscape shots uncropped inside
 * whatever box the panel ends up being (it stretches to match the sibling
 * card's height). Prev/next arrows, the position counter, delete, and
 * (Images stage only) the select-main check and star-rating bar are all
 * overlaid directly on the image itself, never pushed beside/above/below it.
 * Index state is owned by the caller (mirrors how lightboxImage state was
 * already owned by each card) so a freshly generated/uploaded image can make
 * the caller jump to the new last index; the caller's small `.scene-thumb`
 * strip (in the prompt card) also drives this same index.
 *
 * `showSelectMain`/`showStars` are Images-stage-only (SceneTextCard has
 * neither) - `onSelectMain`/`onRate` always act on the currently shown
 * image. `onDropFile`/`onDropUrl` are optional (Images stage only) -
 * dropping a local file or a dragged image URL onto the frame adds a custom
 * image the same way the Upload button does. */
export default function ImageCarousel({
  L, projectId, images, currentIndex, onIndexChange, onExpand,
  onDelete, showSelectMain, onSelectMain, showStars, onRate,
  onDropFile, onDropUrl,
}) {
  const [broken, setBroken] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const total = images.length;
  const image = total ? images[Math.min(currentIndex, total - 1)] : null;
  const showImage = Boolean(image?.file_path) && !broken;
  const canDrop = Boolean(onDropFile || onDropUrl);

  function go(delta) {
    if (total < 2) return;
    onIndexChange((currentIndex + delta + total) % total);
  }

  function handleDrop(e) {
    if (!canDrop) return;
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && onDropFile) {
      onDropFile(file);
      return;
    }
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (url && onDropUrl) onDropUrl(url.trim());
  }

  return (
    <div className="image-carousel is-fill">
      <div
        className={`image-carousel-frame${image?.is_selected ? ' is-main' : ''}${dragOver ? ' is-drag-over' : ''}`}
        onClick={showImage ? () => onExpand(currentIndex) : undefined}
        onDragOver={canDrop ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
        onDragLeave={canDrop ? () => setDragOver(false) : undefined}
        onDrop={handleDrop}
      >
        {showImage ? (
          <img
            src={mediaUrl(`projects/${projectId}/${image.file_path}`)}
            alt=""
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="image-carousel-placeholder">
            {canDrop ? <Upload size={18} /> : null}
          </span>
        )}

        {total > 1 && (
          <>
            <button
              className="image-carousel-nav image-carousel-nav-prev"
              onClick={(e) => { e.stopPropagation(); go(-1); }}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              className="image-carousel-nav image-carousel-nav-next"
              onClick={(e) => { e.stopPropagation(); go(1); }}
            >
              <ChevronRight size={15} />
            </button>
            <span className="image-carousel-counter">{currentIndex + 1} / {total}</span>
          </>
        )}

        {showImage && showSelectMain && (
          <button
            className={`image-thumb-select${image.is_selected ? ' is-active' : ''}`}
            title={L.selectAsMainTitle}
            onClick={(e) => { e.stopPropagation(); onSelectMain(); }}
          >
            <Check size={12} />
          </button>
        )}
        {showImage && (
          <button
            className="image-thumb-delete"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            <Trash2 size={11} />
          </button>
        )}
        {showImage && showStars && (
          <div className="image-carousel-stars" onClick={(e) => e.stopPropagation()}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => onRate(n)}>
                <Star size={13} color={n <= image.rating ? '#ff9d5c' : 'rgba(255,255,255,0.35)'} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

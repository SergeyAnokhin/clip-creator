import { Check, Pencil, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

/** Saved posters (Poster constructor's output) - mirrors TitleCardGallery.jsx's
 * grid shape but simpler: no star rating (a poster is a deliberate layout the
 * user assembled, not an AI variant to rank). Clicking the frame opens
 * `ImageLightbox` on that poster (view the flattened result, same as
 * TitleCardGallery's variants) - the pencil button is the separate "edit"
 * action that reopens PosterConstructor prefilled from the poster's stored
 * layers instead. */
export default function PosterGallery({ L, projectId, posters, onExpand, onEdit, onDelete, onSelectMain }) {
  return (
    <div className="titlecard-gallery">
      {posters.map((poster, i) => (
        <div className="titlecard-gallery-item" key={poster.poster_id}>
          <div
            className={`titlecard-gallery-frame${poster.is_selected ? ' is-main' : ''}`}
            style={{ aspectRatio: `${poster.canvas_size?.width || 1} / ${poster.canvas_size?.height || 1}`, cursor: 'pointer' }}
            onClick={() => onExpand(i)}
          >
            {/* Re-saving an existing poster keeps the same file_path (in-place
                update) - `?v=generated_at` busts the browser's image cache so
                the thumbnail reflects the new PNG instead of the stale one. */}
            <img src={`${mediaUrl(`projects/${projectId}/${poster.file_path}`)}?v=${encodeURIComponent(poster.generated_at || '')}`} alt="" />
            <button
              className={`image-thumb-select${poster.is_selected ? ' is-active' : ''}`}
              title={L.selectAsMainTitle}
              onClick={(e) => { e.stopPropagation(); onSelectMain(i); }}
            >
              <Check size={12} />
            </button>
            <button className="image-thumb-delete" onClick={(e) => { e.stopPropagation(); onDelete(poster.poster_id); }}>
              <Trash2 size={11} />
            </button>
            <button
              className="titlecard-gallery-bg-btn" title={L.poster_edit}
              onClick={(e) => { e.stopPropagation(); onEdit(poster); }}
            >
              <Pencil size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

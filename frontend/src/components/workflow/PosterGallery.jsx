import { Check, Pencil, Trash2 } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

/** Saved posters (Poster constructor's output) - mirrors TitleCardGallery.jsx's
 * grid shape but simpler: no star rating (a poster is a deliberate layout the
 * user assembled, not an AI variant to rank) and an "edit" action that
 * reopens PosterConstructor prefilled from the poster's stored layers
 * instead of generating a new one. */
export default function PosterGallery({ L, projectId, posters, onEdit, onDelete, onSelectMain }) {
  return (
    <div className="titlecard-gallery">
      {posters.map((poster, i) => (
        <div className="titlecard-gallery-item" key={poster.poster_id}>
          <div
            className={`titlecard-gallery-frame${poster.is_selected ? ' is-main' : ''}`}
            style={{ aspectRatio: `${poster.canvas_size?.width || 1} / ${poster.canvas_size?.height || 1}`, cursor: 'pointer' }}
            onClick={() => onEdit(poster)}
          >
            <img src={mediaUrl(`projects/${projectId}/${poster.file_path}`)} alt="" />
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

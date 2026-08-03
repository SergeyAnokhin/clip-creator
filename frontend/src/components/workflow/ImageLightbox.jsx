import { X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

/** Click-to-enlarge modal for a single generated scene image. Controlled by
 * the caller (pass `image: null` / omit rendering to close) - kept as a
 * dumb presentational component so both SceneTextCard.jsx (Scenes stage)
 * and SceneCard.jsx/ImageThumb.jsx (Images stage) can reuse it without any
 * shared state. */
export default function ImageLightbox({ projectId, image, onClose }) {
  if (!image) return null;
  return (
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
        />
      </div>
    </div>
  );
}

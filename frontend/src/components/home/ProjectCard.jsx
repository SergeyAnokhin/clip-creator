import { Calendar, FolderOpen, Image, Music2, Trash2 } from 'lucide-react';
import { formatDate } from '../../lib/format.js';

export default function ProjectCard({ project, L, lang, onOpen, onDelete }) {
  const scenesComplete = project.scenes_ready === project.scenes_total;

  return (
    <div className="project-card" onClick={() => onOpen(project.id)}>
      <div className="project-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="project-card-title">{project.title}</div>
          <div className="project-card-author">{project.author}</div>
        </div>
        <button
          className="icon-btn icon-btn-danger"
          style={{ width: 30, height: 30 }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(project.id);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="project-card-date">
        <Calendar size={12} />
        {formatDate(project.date, lang)}
      </div>

      <div className="project-card-pills">
        <span className={`pill ${project.suno_done ? 'pill-success' : 'pill-neutral'}`}>
          <Music2 size={12} />
          {project.suno_done ? L.sunoDone : L.sunoPending}
        </span>
        <span className={`pill ${scenesComplete ? 'pill-accent' : 'pill-neutral'}`}>
          <Image size={12} />
          {project.scenes_ready}/{project.scenes_total} {L.scenesReady}
        </span>
      </div>

      <div className="project-card-tags">
        {project.tags.map((tag) => (
          <span key={tag} className="tag">{tag}</span>
        ))}
      </div>

      <div className="project-card-footer">
        <FolderOpen size={14} />
        {L.open}
      </div>
    </div>
  );
}

import ProjectCard from './ProjectCard.jsx';

export default function ProjectGrid({ projects, L, lang, columns, onOpen, onDelete }) {
  return (
    <div className="project-grid" style={{ gridTemplateColumns: columns }}>
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} L={L} lang={lang} onOpen={onOpen} onDelete={onDelete} />
      ))}
    </div>
  );
}

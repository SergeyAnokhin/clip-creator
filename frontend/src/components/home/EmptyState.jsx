import { Sparkles } from 'lucide-react';

export default function EmptyState({ L, onNewWorkflow }) {
  return (
    <div className="empty-state">
      <Sparkles size={32} />
      <div className="empty-state-title">{L.emptyTitle}</div>
      <div className="empty-state-subtitle">{L.emptySubtitle}</div>
      <button className="btn btn-gradient" onClick={onNewWorkflow}>
        {L.newWorkflow}
      </button>
    </div>
  );
}

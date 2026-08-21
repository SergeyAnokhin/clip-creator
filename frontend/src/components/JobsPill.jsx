import { useState } from 'react';
import { Zap } from 'lucide-react';
import { useElapsedTick } from '../hooks/useJobs.js';
import { stageName } from '../lib/stageStatus.js';

function elapsedLabel(startedAt) {
  const total = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Header indicator for jobs running anywhere in the app (see `useJobs.js`).
 * Renders nothing while idle, the same way `MiniPlayerWidget` does, so it
 * costs no header space until there is something to say. */
export default function JobsPill({ L, jobs }) {
  const [expanded, setExpanded] = useState(false);
  useElapsedTick(jobs.length > 0);

  if (jobs.length === 0) return null;
  const oldest = jobs.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        className="pill pill-running"
        style={{ cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
        onClick={() => setExpanded((e) => !e)}
        title={L.jobs_pillTitle}
        aria-label={L.jobs_pillTitle}
      >
        <Zap size={12} className="jobs-pill-icon" />
        {jobs.length > 1 ? `${jobs.length} · ` : ''}{elapsedLabel(oldest.startedAt)}
      </button>
      {expanded && (
        <div
          className="glass-card"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30,
            width: 240, padding: 12, fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div style={{ color: 'var(--text-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {L.jobs_pillTitle}
          </div>
          {jobs.map((job) => (
            <div key={job.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {stageName(L, job.stage)}
                {job.detail ? <span style={{ color: 'var(--text-dim)' }}> · {job.detail}</span> : null}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {elapsedLabel(job.startedAt)}
              </span>
            </div>
          ))}
          <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>{L.jobs_keepOpenHint}</div>
        </div>
      )}
    </div>
  );
}

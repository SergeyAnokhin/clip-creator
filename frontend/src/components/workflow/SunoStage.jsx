import { Copy, MessageSquare, Mic, Sparkles, Zap } from 'lucide-react';

const SKILLS = [
  { id: 'skill_a', label: 'Suno Structure & Style Pro' },
  { id: 'skill_b', label: 'Suno Lyrics Adapter' },
];

export default function SunoStage({
  L, project, skillId, refinementText, isRecordingRefinement, recordingSeconds,
  sunoLoading, trackUrl, actions,
}) {
  return (
    <>
      <div className="stage-heading-title" style={{ marginBottom: 4 }}>{L.sunoStageTitle}</div>
      <div className="stage-heading-subtitle" style={{ marginBottom: 18 }}>{L.sunoStageSubtitle}</div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title">
          <Sparkles size={16} color="#ff9d5c" />
          {L.selectedSkill}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {SKILLS.map((sk) => (
            <button
              key={sk.id}
              className={`chip${skillId === sk.id ? ' is-active' : ''}`}
              onClick={() => actions.selectSkill(sk.id)}
            >
              {sk.label}
            </button>
          ))}
        </div>
        <textarea
          className="suno-textarea"
          value={project.skill_prompt}
          onChange={(e) => actions.setSkillPrompt(e.target.value)}
        />
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title">
          <MessageSquare size={16} color="#ff9d5c" />
          {L.refinement}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            className="field"
            value={refinementText}
            onChange={(e) => actions.setRefinementText(e.target.value)}
            placeholder={L.refinementPlaceholder}
          />
          <button className="icon-btn" style={{ width: 38, height: 38 }} onClick={() => actions.startVoice('refinement')}>
            <Mic size={15} />
          </button>
          <button className="btn btn-accent-soft" style={{ flexShrink: 0 }} onClick={actions.applyRefinement}>
            {L.apply}
          </button>
        </div>
        {isRecordingRefinement && (
          <div className="recording-banner" style={{ marginTop: 10 }}>
            <span className="recording-dot" />
            {L.recording} · {recordingSeconds}s
          </div>
        )}
      </div>

      <button className="btn btn-gradient" style={{ marginBottom: 18, padding: '12px 20px', fontSize: 14 }} onClick={actions.generateSuno}>
        <Zap size={16} />
        {L.generateForSuno}
      </button>

      {sunoLoading && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>⏳ {L.generatingSuno}</div>
      )}

      {!!project.style && (
        <>
          <div className="glass-card" style={{ marginBottom: 12 }}>
            <div className="result-panel-header">
              <span className="result-panel-label">{L.styleOfMusic}</span>
              <button className="result-panel-copy" onClick={actions.copyStyle}>
                <Copy size={12} />
                {L.copyStyle}
              </button>
            </div>
            <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>{project.style}</div>
          </div>

          <div className="glass-card" style={{ marginBottom: 16 }}>
            <div className="result-panel-header">
              <span className="result-panel-label">{L.songLyrics}</span>
              <button className="result-panel-copy" onClick={actions.copyLyrics}>
                <Copy size={12} />
                {L.copyLyrics}
              </button>
            </div>
            <pre style={{ margin: 0, fontFamily: "'SF Mono',monospace", fontSize: 12.5, color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
              {project.lyrics}
            </pre>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="field"
              value={trackUrl}
              onChange={(e) => actions.setTrackUrl(e.target.value)}
              placeholder={L.trackUrlPlaceholder}
            />
            <button
              className="btn"
              style={{ background: 'rgba(74,222,128,0.14)', border: '1px solid rgba(74,222,128,0.3)', color: '#86efac', fontWeight: 700 }}
              onClick={actions.saveTrackUrl}
            >
              {L.saveLink}
            </button>
          </div>
        </>
      )}
    </>
  );
}

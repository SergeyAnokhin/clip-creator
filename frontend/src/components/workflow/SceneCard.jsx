import { Film, Image as ImageIcon, ImagePlus, Mic } from 'lucide-react';
import ImageThumb from './ImageThumb.jsx';

export default function SceneCard({ L, projectId, scene, index, isRecording, recordingSeconds, isLoading, columns, actions }) {
  return (
    <div className="glass-card">
      <div className="scene-card-header">
        <span className="scene-number">{index + 1}</span>
        <span className="scene-lyric-segment">{scene.lyric_segment}</span>
      </div>

      <div className="scene-prompt-grid" style={{ gridTemplateColumns: columns }}>
        <div>
          <div className="scene-prompt-label">
            <ImageIcon size={12} />
            {L.staticPrompt}
          </div>
          <textarea
            className="scene-textarea"
            value={scene.static_prompt}
            onChange={(e) => actions.onStaticChange(index, e.target.value)}
          />
        </div>
        <div>
          <div className="scene-prompt-label">
            <Film size={12} />
            {L.motionPrompt}
          </div>
          <textarea
            className="scene-textarea"
            value={scene.motion_prompt}
            onChange={(e) => actions.onMotionChange(index, e.target.value)}
          />
        </div>
      </div>

      <div className="scene-actions">
        <button className="btn btn-gradient" style={{ padding: '8px 15px' }} onClick={() => actions.onGenerate(index)}>
          <ImagePlus size={13} />
          {L.generateImages}
        </button>
        <button className="icon-btn" style={{ width: 34, height: 34 }} onClick={() => actions.onVoiceEdit(index)}>
          <Mic size={13} />
        </button>
        {isRecording && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#f87171' }}>
            <span className="recording-dot" style={{ width: 8, height: 8 }} />
            {L.recording} · {recordingSeconds}s
          </span>
        )}
      </div>

      {isLoading && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>⏳ {L.generatingImage}</div>}

      {scene.images.length > 0 && (
        <div className="image-grid">
          {scene.images.map((img, imgIdx) => (
            <ImageThumb
              key={imgIdx}
              projectId={projectId}
              image={img}
              onSelectMain={() => actions.onSelectMain(index, imgIdx)}
              onRate={(rating) => actions.onRate(index, imgIdx, rating)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

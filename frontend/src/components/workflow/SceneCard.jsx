import { useState } from 'react';
import { Film, Image as ImageIcon, ImagePlus, Mic, MicOff } from 'lucide-react';
import ImageThumb from './ImageThumb.jsx';
import TranslateButton from './TranslateButton.jsx';
import ImageLightbox from './ImageLightbox.jsx';

export default function SceneCard({
  L, projectId, scene, index, isRecording, recordingSeconds, voiceSupported, isLoading, columns, hideMotionPrompt, actions,
}) {
  const [lightboxImage, setLightboxImage] = useState(null);

  return (
    <div className="glass-card">
      <div className="scene-card-header">
        <span className="scene-number">{index + 1}</span>
        <span className="scene-lyric-segment">{scene.lyric_segment}</span>
      </div>

      <div className="scene-card-body">
        <div className="scene-card-body-text">
          <div className="scene-prompt-grid" style={{ gridTemplateColumns: columns }}>
            <div>
              <div className="scene-prompt-label">
                <ImageIcon size={12} />
                {L.staticPrompt}
                <TranslateButton L={L} text={scene.static_prompt} />
              </div>
              <textarea
                className="scene-textarea"
                value={scene.static_prompt}
                onChange={(e) => actions.onStaticChange(index, e.target.value)}
              />
            </div>
            {!hideMotionPrompt && (
              <div>
                <div className="scene-prompt-label">
                  <Film size={12} />
                  {L.motionPrompt}
                  <TranslateButton L={L} text={scene.motion_prompt} />
                </div>
                <textarea
                  className="scene-textarea"
                  value={scene.motion_prompt}
                  onChange={(e) => actions.onMotionChange(index, e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="scene-actions">
            <button className="btn btn-gradient" style={{ padding: '8px 15px' }} onClick={() => actions.onGenerate(index)}>
              <ImagePlus size={13} />
              {L.generateImages}
            </button>
            {voiceSupported && (
              <button
                className={`icon-btn${isRecording ? ' icon-btn-recording' : ''}`}
                style={{ width: 34, height: 34 }}
                onClick={() => actions.onVoiceEdit(index)}
              >
                {isRecording ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
            )}
            {isRecording && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#f87171' }}>
                <span className="recording-dot" style={{ width: 8, height: 8 }} />
                {L.recording} · {recordingSeconds}s
              </span>
            )}
          </div>

          {isLoading && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>⏳ {L.generatingImage}</div>}
        </div>

        {scene.images.length > 0 && (
          <div className="image-grid" style={{ width: 160, flexShrink: 0 }}>
            {scene.images.map((img, imgIdx) => (
              <ImageThumb
                key={imgIdx}
                projectId={projectId}
                image={img}
                onSelectMain={() => actions.onSelectMain(index, imgIdx)}
                onRate={(rating) => actions.onRate(index, imgIdx, rating)}
                onExpand={() => setLightboxImage(img)}
              />
            ))}
          </div>
        )}
      </div>

      <ImageLightbox projectId={projectId} image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
}

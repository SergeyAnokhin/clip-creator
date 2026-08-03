import { useState } from 'react';
import { Film, ImagePlus, Image as ImageIcon, Loader2, Mic, MicOff } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import TranslateButton from './TranslateButton.jsx';
import ImageLightbox from './ImageLightbox.jsx';

/** Scenes (text) stage's per-scene card - lyric segment + editable
 * static/motion prompt, plus a quick single-cheap-image preview on the right
 * (see useScenesStage.js's `generateSceneImage` - shares `scene.images` with
 * the Images stage's full multi-variant/rating workflow in SceneCard.jsx,
 * this is just a fast "what does this roughly look like" check without
 * leaving the Scenes stage). */
export default function SceneTextCard({
  L, projectId, scene, index, isRecording, recordingSeconds, voiceSupported, columns, hideMotionPrompt,
  isImageLoading, actions,
}) {
  const [lightboxImage, setLightboxImage] = useState(null);
  const lastImage = scene.images?.length ? scene.images[scene.images.length - 1] : null;

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

          {voiceSupported && (
            <div className="scene-actions">
              <button
                className={`icon-btn${isRecording ? ' icon-btn-recording' : ''}`}
                style={{ width: 34, height: 34 }}
                onClick={() => actions.onVoiceEdit(index)}
              >
                {isRecording ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
              {isRecording && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#f87171' }}>
                  <span className="recording-dot" style={{ width: 8, height: 8 }} />
                  {L.recording} · {recordingSeconds}s
                </span>
              )}
            </div>
          )}
        </div>

        <div className="scene-image-slot">
          <button
            className="btn btn-accent-soft" style={{ padding: '7px 12px', fontSize: 12.5 }}
            onClick={() => actions.onGenerateImage(index)} disabled={isImageLoading}
          >
            {isImageLoading ? <Loader2 size={13} className="spin" /> : <ImagePlus size={13} />}
            {lastImage ? L.regenerateImage : L.generateImage}
          </button>
          {lastImage && (
            <div
              className="image-thumb-frame"
              style={{ width: '100%', height: 160 }}
              onClick={() => setLightboxImage(lastImage)}
            >
              <img
                src={mediaUrl(`projects/${projectId}/${lastImage.file_path}`)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 12 }}
              />
            </div>
          )}
        </div>
      </div>

      <ImageLightbox projectId={projectId} image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
}

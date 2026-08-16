import { useEffect, useRef, useState } from 'react';
import { Film, ImagePlus, Image as ImageIcon, Loader2, Mic, MicOff } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import TranslateButton from './TranslateButton.jsx';
import CopyButton from './CopyButton.jsx';
import ImageCarousel from './ImageCarousel.jsx';
import ImageLightbox from './ImageLightbox.jsx';

/** Scenes (text) stage's per-scene card - lyric segment + editable
 * static/motion prompt, plus a quick single-cheap-image preview (see
 * useScenesStage.js's `generateSceneImage` - shares `scene.images` with the
 * Images stage's full multi-variant/rating workflow in SceneCard.jsx, this
 * is just a fast "what does this roughly look like" check without leaving
 * the Scenes stage). Laid out as two blocks side by side (`.scene-row`): the
 * prompt card (this component's own `.glass-card`, small clickable
 * thumbnails at the bottom pick which image is current) and a separate
 * padding-less `.scene-image-panel` that gives the current image the whole
 * remaining block, edge-to-edge - see ImageCarousel.jsx's docstring. */
export default function SceneTextCard({
  L, projectId, scene, index, isRecording, recordingSeconds, voiceSupported, columns, hideMotionPrompt,
  isImageLoading, actions,
}) {
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(Math.max(0, scene.images.length - 1));
  const prevLengthRef = useRef(scene.images.length);
  const boundedIndex = Math.min(currentIndex, Math.max(0, scene.images.length - 1));
  const hasImages = scene.images.length > 0;

  // Jump to the newest image whenever one is added (generated/uploaded), but
  // don't fight the user's browsing position on delete.
  useEffect(() => {
    if (scene.images.length > prevLengthRef.current) {
      setCurrentIndex(scene.images.length - 1);
    }
    prevLengthRef.current = scene.images.length;
  }, [scene.images.length]);

  return (
    <div className="scene-row">
      <div className="glass-card scene-card">
        <div className="scene-card-header">
          <span className="scene-number">{index + 1}</span>
          <div>
            {scene.scene_description && <div className="scene-description">{scene.scene_description}</div>}
            <span className="scene-lyric-segment">{scene.lyric_segment}</span>
          </div>
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
            <div className="scene-field-actions">
              <TranslateButton L={L} text={scene.static_prompt} />
              <CopyButton L={L} text={scene.static_prompt} />
            </div>
          </div>
          {!hideMotionPrompt && (
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
              <div className="scene-field-actions">
                <TranslateButton L={L} text={scene.motion_prompt} />
                <CopyButton L={L} text={scene.motion_prompt} />
              </div>
            </div>
          )}
        </div>

        <div className="scene-actions">
          <div className="scene-actions-left">
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
          <button
            className="btn btn-accent-soft" style={{ padding: '7px 12px', fontSize: 12.5 }}
            onClick={() => actions.onGenerateImage(index)} disabled={isImageLoading}
          >
            {isImageLoading ? <Loader2 size={13} className="spin" /> : <ImagePlus size={13} />}
            {hasImages ? L.regenerateImage : L.generateImage}
          </button>
        </div>

        {scene.images.length > 1 && (
          <div className="scene-thumb-strip">
            {scene.images.map((img, i) => (
              <button
                key={img.image_id}
                className={`scene-thumb${i === boundedIndex ? ' is-active' : ''}`}
                title={L.pickImageTitle}
                aria-label={`${L.pickImageTitle} ${i + 1}`}
                onClick={() => setCurrentIndex(i)}
              >
                <img src={mediaUrl(`projects/${projectId}/${img.file_path}`)} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card scene-image-panel">
        <ImageCarousel
          L={L}
          projectId={projectId}
          images={scene.images}
          currentIndex={boundedIndex}
          onIndexChange={setCurrentIndex}
          onExpand={(i) => setLightboxIndex(i)}
          onDelete={() => actions.onDeleteImage(index, boundedIndex)}
        />
      </div>

      <ImageLightbox
        L={L} projectId={projectId}
        images={lightboxIndex == null ? [] : scene.images}
        initialIndex={lightboxIndex || 0}
        onClose={() => setLightboxIndex(null)}
      />
    </div>
  );
}

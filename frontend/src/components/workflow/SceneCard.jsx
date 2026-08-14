import { useEffect, useRef, useState } from 'react';
import { Film, Image as ImageIcon, ImagePlus, Mic, MicOff, Upload } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import ImageCarousel from './ImageCarousel.jsx';
import TranslateButton from './TranslateButton.jsx';
import CopyButton from './CopyButton.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import ImageCropEditor from './ImageCropEditor.jsx';

/** Images stage's per-scene card - same prompt/mic/translate/copy layout as
 * SceneTextCard.jsx, laid out as two blocks side by side (`.scene-row`): the
 * prompt card (this component's own `.glass-card`, upload panel, small
 * clickable thumbnails at the bottom pick which variant is current) and a
 * separate padding-less `.scene-image-panel` that gives the current image
 * the whole remaining block, edge-to-edge, with select-main/star-rating
 * overlaid directly on it - see ImageCarousel.jsx's docstring. */
export default function SceneCard({
  L, projectId, scene, index, isRecording, recordingSeconds, voiceSupported, isLoading, columns, hideMotionPrompt,
  outpaintQualityMode, magicLayerGroups, magicBusySources, actions,
}) {
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [cropEditIndex, setCropEditIndex] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(Math.max(0, scene.images.length - 1));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadUrl, setUploadUrl] = useState('');
  const prevLengthRef = useRef(scene.images.length);
  const fileInputRef = useRef(null);
  const boundedIndex = Math.min(currentIndex, Math.max(0, scene.images.length - 1));

  useEffect(() => {
    if (scene.images.length > prevLengthRef.current) {
      setCurrentIndex(scene.images.length - 1);
    }
    prevLengthRef.current = scene.images.length;
  }, [scene.images.length]);

  function submitUrl() {
    const url = uploadUrl.trim();
    if (!url) return;
    actions.onUploadImageUrl(index, url);
    setUploadUrl('');
    setUploadOpen(false);
  }

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
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-accent-soft" style={{ padding: '7px 12px', fontSize: 12.5 }}
              onClick={() => setUploadOpen((o) => !o)}
            >
              <Upload size={13} />
              {L.uploadSceneImage}
            </button>
            <button className="btn btn-gradient" style={{ padding: '8px 15px' }} onClick={() => actions.onGenerate(index)}>
              <ImagePlus size={13} />
              {L.generateImages}
            </button>
          </div>
        </div>

        {uploadOpen && (
          <div className="scene-upload-panel">
            <button className="btn btn-accent-soft" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => fileInputRef.current?.click()}>
              {L.uploadFromFile}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) actions.onUploadImageFile(index, file);
                e.target.value = '';
                setUploadOpen(false);
              }}
            />
            <input
              className="field"
              style={{ flex: 1, minWidth: 160 }}
              value={uploadUrl}
              onChange={(e) => setUploadUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
              placeholder={L.uploadFromUrlPlaceholder}
            />
            <button className="btn btn-accent-soft" style={{ padding: '6px 11px', fontSize: 12 }} onClick={submitUrl} disabled={!uploadUrl.trim()}>
              {L.uploadFromUrlAction}
            </button>
          </div>
        )}

        {isLoading && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>⏳ {L.generatingImage}</div>}

        {scene.images.length > 1 && (
          <div className="scene-thumb-strip">
            {scene.images.map((img, i) => (
              <button
                key={img.image_id}
                className={`scene-thumb${i === boundedIndex ? ' is-active' : ''}`}
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
          onDelete={() => actions.onDelete(index, boundedIndex)}
          showSelectMain
          onSelectMain={() => actions.onSelectMain(index, boundedIndex)}
          showStars
          onRate={(rating) => actions.onRate(index, boundedIndex, rating)}
          onDropFile={(file) => actions.onUploadImageFile(index, file)}
          onDropUrl={(url) => actions.onUploadImageUrl(index, url)}
          onCrop={() => setCropEditIndex(boundedIndex)}
          onDecomposeMagicLayers={actions.decomposeMagicLayers}
          magicLayerGroups={magicLayerGroups}
          magicBusySources={magicBusySources}
        />
      </div>

      <ImageLightbox
        L={L} projectId={projectId}
        images={lightboxIndex == null ? [] : scene.images}
        initialIndex={lightboxIndex || 0}
        onClose={() => setLightboxIndex(null)}
      />

      {cropEditIndex != null && scene.images[cropEditIndex] && (
        <ImageCropEditor
          L={L} projectId={projectId}
          image={scene.images[cropEditIndex]}
          defaultQuality={outpaintQualityMode}
          onSave={(cropBox, quality) => actions.onCropImage(index, cropEditIndex, cropBox, quality)}
          onClose={() => setCropEditIndex(null)}
        />
      )}
    </div>
  );
}

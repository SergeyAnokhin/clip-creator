import { useRef, useState } from 'react';
import { ArrowRight, Minus, Plus, Upload, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import SceneCard from './SceneCard.jsx';
import ModelPicker from './ModelPicker.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import StageMoreOptions from './StageMoreOptions.jsx';

const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16'];

export default function ImagesStage({
  L, project, isMobile, onSelectStage, imageModel, imageModelTier, imageModelFavorites, imageModelSimpleFavorites, modelPrices,
  variantCount, referenceUploading, hideMotionPrompt, aspectRatio, outpaintQualityMode,
  magicLayerGroups, magicBusySources,
  sceneLoadingIdx, sceneRecordingIdx, recordingSeconds, voiceSupported, actions,
}) {
  const fileInputRef = useRef(null);
  const [lightboxImage, setLightboxImage] = useState(null);
  const tierFavorites = imageModelTier === 'simple' ? imageModelSimpleFavorites : imageModelFavorites;

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.imagesStageTitle}</div>
          <div className="stage-heading-subtitle">{L.imagesStageSubtitle}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 2 }}>{L.imageModelTierLabel}:</span>
        <button className={`chip${imageModelTier === 'simple' ? ' is-active' : ''}`} onClick={() => actions.setImageModelTier('simple')}>
          {L.imageModelTier_simple}
        </button>
        <button className={`chip${imageModelTier === 'main' ? ' is-active' : ''}`} onClick={() => actions.setImageModelTier('main')}>
          {L.imageModelTier_main}
        </button>

        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10, marginRight: 2 }}>{L.imageModel}:</span>
        <ModelPicker
          favorites={tierFavorites}
          value={imageModel}
          onChange={actions.selectImageModel}
          emptyLabel={L.modelPickerEmpty}
          prices={modelPrices}
          L={L}
        />

        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10, marginRight: 2 }}>{L.variantCountLabel}:</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setVariantCount(Math.max(0, variantCount - 1))}>
          <Minus size={12} />
        </button>
        <span style={{ fontSize: 13, minWidth: 16, textAlign: 'center' }}>{variantCount}</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setVariantCount(Math.min(4, variantCount + 1))}>
          <Plus size={12} />
        </button>
      </div>

      <StageMoreOptions L={L} storageKey="images">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 2 }}>{L.aspectRatioLabel}:</span>
        {ASPECT_RATIOS.map((ratio) => (
          <button
            key={ratio}
            className={`chip${aspectRatio === ratio ? ' is-active' : ''}`}
            onClick={() => actions.setAspectRatio(ratio)}
          >
            {L[`aspectRatio_${ratio === 'auto' ? 'auto' : ratio.replace(':', '_')}`]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <button
          className={`chip${hideMotionPrompt ? ' is-active' : ''}`}
          onClick={() => actions.setHideMotionPrompt(!hideMotionPrompt)}
        >
          {L.hideMotionPromptLabel}
        </button>
      </div>

      <div className="glass-card" style={{ marginBottom: 18 }}>
        <div className="scene-prompt-label">{L.referenceImagesLabel}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {(project.reference_images || []).map((path) => (
            <div key={path} style={{ position: 'relative', width: 64, height: 64 }}>
              <button
                type="button"
                title={L.expandImageTitle}
                aria-label={L.expandImageTitle}
                style={{ width: '100%', height: '100%', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                onClick={() => setLightboxImage(path)}
              >
                <img
                  src={mediaUrl(`projects/${project.id}/${path}`)}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8, display: 'block' }}
                />
              </button>
              <button
                className="icon-btn"
                style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20 }}
                onClick={(e) => { e.stopPropagation(); actions.removeReference(path); }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            className="btn btn-accent-soft"
            style={{ padding: '8px 13px' }}
            onClick={() => fileInputRef.current?.click()}
            disabled={referenceUploading}
          >
            <Upload size={13} />
            {L.uploadReference}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) actions.uploadReference(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      </StageMoreOptions>

      {project.scenes.length === 0 ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          <div style={{ marginBottom: 12 }}>{L.noScenesYet}</div>
          <button className="btn btn-accent-soft" onClick={() => onSelectStage('scenes')}>
            {L.stage_scenes}
            <ArrowRight size={14} />
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {project.scenes.map((scene, index) => (
            <SceneCard
              key={index}
              L={L}
              projectId={project.id}
              index={index}
              scene={scene}
              isRecording={sceneRecordingIdx === index}
              recordingSeconds={recordingSeconds}
              voiceSupported={voiceSupported}
              isLoading={sceneLoadingIdx === index}
              columns={isMobile ? '1fr' : hideMotionPrompt ? '1fr' : '1fr 1fr'}
              hideMotionPrompt={hideMotionPrompt}
              outpaintQualityMode={outpaintQualityMode}
              magicLayerGroups={magicLayerGroups}
              magicBusySources={magicBusySources}
              actions={actions}
            />
          ))}
        </div>
      )}

      <ImageLightbox
        L={L} projectId={project.id}
        images={lightboxImage ? [{ file_path: lightboxImage }] : []}
        onClose={() => setLightboxImage(null)}
      />
    </>
  );
}

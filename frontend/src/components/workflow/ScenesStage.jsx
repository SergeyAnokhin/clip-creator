import { useRef } from 'react';
import { Minus, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import SceneCard from './SceneCard.jsx';
import ModelPicker from './ModelPicker.jsx';

export default function ScenesStage({
  L, project, isMobile, imageModel, sceneTextModel, imageModelFavorites, textModelFavorites, modelPrices,
  variantCount, styleDescription, storyboardLoading, referenceUploading,
  sceneLoadingIdx, sceneRecordingIdx, recordingSeconds, voiceSupported, actions,
}) {
  const fileInputRef = useRef(null);

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.scenesStageTitle}</div>
          <div className="stage-heading-subtitle">{L.scenesStageSubtitle}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ModelPicker
            favorites={textModelFavorites}
            value={sceneTextModel}
            onChange={actions.selectSceneTextModel}
            emptyLabel={L.modelPickerEmpty}
            prices={modelPrices}
            L={L}
          />
          <button className="btn btn-accent-soft" onClick={actions.generateStoryboard} disabled={storyboardLoading}>
            <RefreshCw size={12} />
            {storyboardLoading ? L.generatingStoryboard : L.generateStoryboard}
          </button>
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: 18 }}>
        <div className="scene-prompt-label">{L.styleDescriptionLabel}</div>
        <textarea
          className="scene-textarea"
          value={styleDescription}
          placeholder={L.styleDescriptionPlaceholder}
          onChange={(e) => actions.onStyleDescriptionChange(e.target.value)}
        />

        <div className="scene-prompt-label" style={{ marginTop: 14 }}>{L.referenceImagesLabel}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {(project.reference_images || []).map((path) => (
            <div key={path} style={{ position: 'relative', width: 64, height: 64 }}>
              <img
                src={mediaUrl(`projects/${project.id}/${path}`)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }}
              />
              <button
                className="icon-btn"
                style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20 }}
                onClick={() => actions.removeReference(path)}
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-faint)', marginRight: 2 }}>{L.imageModel}:</span>
        <ModelPicker
          favorites={imageModelFavorites}
          value={imageModel}
          onChange={actions.selectImageModel}
          emptyLabel={L.modelPickerEmpty}
          prices={modelPrices}
          L={L}
        />

        <span style={{ fontSize: 12, color: 'var(--text-faint)', marginLeft: 10, marginRight: 2 }}>{L.variantCountLabel}:</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setVariantCount(Math.max(0, variantCount - 1))}>
          <Minus size={12} />
        </button>
        <span style={{ fontSize: 13, minWidth: 16, textAlign: 'center' }}>{variantCount}</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setVariantCount(Math.min(4, variantCount + 1))}>
          <Plus size={12} />
        </button>
      </div>

      {project.scenes.length === 0 ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {L.noStoryboardYet}
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
              columns={isMobile ? '1fr' : '1fr 1fr'}
              actions={actions}
            />
          ))}
        </div>
      )}
    </>
  );
}

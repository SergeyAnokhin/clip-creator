import { RefreshCw } from 'lucide-react';
import SceneCard from './SceneCard.jsx';

const IMAGE_MODELS = [
  { id: 'flux', label: 'FLUX 1.1 Pro' },
  { id: 'dalle', label: 'DALL-E 3' },
  { id: 'midjourney', label: 'Midjourney' },
  { id: 'sdxl', label: 'SDXL' },
];

export default function ScenesStage({
  L, project, isMobile, imageModel, sceneLoadingIdx, sceneRecordingIdx, recordingSeconds, actions,
}) {
  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.scenesStageTitle}</div>
          <div className="stage-heading-subtitle">{L.scenesStageSubtitle}</div>
        </div>
        <button className="btn btn-accent-soft" onClick={actions.regenerateAll}>
          <RefreshCw size={12} />
          {L.regenerateAll}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-faint)', marginRight: 2 }}>{L.imageModel}:</span>
        {IMAGE_MODELS.map((m) => (
          <button
            key={m.id}
            className={`chip${imageModel === m.id ? ' is-active' : ''}`}
            style={{ padding: '6px 13px', fontSize: 12 }}
            onClick={() => actions.selectImageModel(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {project.scenes.map((scene, index) => (
          <SceneCard
            key={index}
            L={L}
            index={index}
            scene={{ ...scene, lyricSegment: (project.blocks[index]?.content || '').split('\n')[0] }}
            isRecording={sceneRecordingIdx === index}
            recordingSeconds={recordingSeconds}
            isLoading={sceneLoadingIdx === index}
            columns={isMobile ? '1fr' : '1fr 1fr'}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}

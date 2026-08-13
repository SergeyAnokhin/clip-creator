import { Check, Download, Film, Music4, Type as TypeIcon } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';

/** Export stage - the last step: a single "download the finished project"
 * button plus the two picks it depends on. Videos need no picker here -
 * every generated candidate for every scene goes into the archive, ranked by
 * its own star rating in the filename (see `export_final_package`'s
 * docstring), so nothing needs to be marked on this screen for videos to
 * show up. Audio just reflects the Mureka stage's own `is_selected` track
 * (no separate pick here - one track can be "the one" at a time already).
 * Title cards are the one thing genuinely new: `TitleCardStage.jsx`'s
 * `is_selected` only ever marks a single "main" variant, so this stage adds
 * its own `marked_for_export` toggle per variant to allow several at once. */
export default function ExportStage({ L, project, actions }) {
  const scenes = project.scenes || [];
  const totalVideos = scenes.reduce((sum, s) => sum + (s.videos?.length || 0), 0);
  const scenesWithVideo = scenes.filter((s) => (s.videos?.length || 0) > 0).length;

  const tracks = project.mureka?.tracks || [];
  const selectedTrack = tracks.find((t) => t.is_selected);

  const variants = project.title_card?.variants || [];
  const markedVariants = variants.filter((v) => v.marked_for_export);

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.exportStageTitle}</div>
          <div className="stage-heading-subtitle">{L.exportStageSubtitle}</div>
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title"><Music4 size={16} color="#ff9d5c" />{L.export_audioTitle}</div>
        {selectedTrack ? (
          <div style={{ fontSize: 13 }}>
            {L.export_audioSelected}: <strong>{(selectedTrack.file_path || '').split('/').pop()}</strong>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: '#fbbf24' }}>⚠️ {L.export_audioNoneSelected}</div>
        )}
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title"><TypeIcon size={16} color="#ff9d5c" />{L.export_titleCardsTitle}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.export_titleCardsHint}</div>
        {!variants.length ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.export_titleCardsNone}</div>
        ) : (
          <>
            <div className="titlecard-gallery">
              {variants.map((variant, i) => {
                const [w, h] = (variant.aspect_ratio || '1:1').split(':').map(Number);
                const marked = !!variant.marked_for_export;
                return (
                  <div className="titlecard-gallery-item" key={variant.variant_id || i}>
                    <div
                      className={`titlecard-gallery-frame${marked ? ' is-main' : ''}`}
                      style={{ aspectRatio: `${w || 1} / ${h || 1}`, cursor: 'pointer' }}
                      onClick={() => actions.toggleTitleCardExport(i)}
                    >
                      <img src={mediaUrl(`projects/${project.id}/${variant.file_path}`)} alt="" />
                      <button
                        className={`image-thumb-select${marked ? ' is-active' : ''}`}
                        title={L.export_toggleTitleCard}
                        onClick={(e) => { e.stopPropagation(); actions.toggleTitleCardExport(i); }}
                      >
                        <Check size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!markedVariants.length && (
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 10 }}>{L.export_titleCardsFallbackHint}</div>
            )}
          </>
        )}
      </div>

      <div className="glass-card" style={{ marginBottom: 20 }}>
        <div className="suno-panel-title"><Film size={16} color="#ff9d5c" />{L.export_videosTitle}</div>
        <div style={{ fontSize: 13 }}>
          {L.export_videosSummary.replace('{count}', totalVideos).replace('{scenes}', scenesWithVideo).replace('{total}', scenes.length)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{L.export_videosHint}</div>
      </div>

      <button className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }} onClick={actions.downloadExport}>
        <Download size={16} />
        {L.export_downloadButton}
      </button>
    </>
  );
}

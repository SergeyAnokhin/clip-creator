import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ImagePlus, Layers, Loader2, Mic, MicOff, Minus, Plus, Sparkles, Upload, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import ModelPicker from './ModelPicker.jsx';
import TitleCardGallery from './TitleCardGallery.jsx';
import PosterGallery from './PosterGallery.jsx';
import PosterConstructor from './PosterConstructor.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import { sortByUseCount } from '../../lib/wishes.js';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16'];

/** `12с` / `1м 05с` (or the EN `12s` / `1m 05s`) - mirrors SunoStage.jsx's
 * local helper of the same name. */
function formatDuration(totalSeconds, L) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}${L.suno_unitSeconds}`;
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}${L.suno_unitMinutes} ${rem}${L.suno_unitSeconds}`;
}

function DebugPanel({ L, lastDebug }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div
        className="suno-panel-title"
        style={{ marginBottom: open ? 12 : 0, cursor: 'pointer', justifyContent: 'space-between' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {L.titleCard_debugTitle}
        </span>
      </div>
      {open && (
        !lastDebug ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.titleCard_debugNoData}</div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{L.scene_debugRequestLabel}</div>
            <pre
              style={{
                margin: 0, marginBottom: 12, fontFamily: "'SF Mono',monospace", fontSize: 11.5,
                color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.6, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {JSON.stringify(lastDebug.request, null, 2)}
            </pre>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{L.scene_debugResponseLabel}</div>
            <pre
              style={{
                margin: 0, fontFamily: "'SF Mono',monospace", fontSize: 11.5,
                color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.6, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {JSON.stringify(lastDebug.response, null, 2)}
            </pre>
          </>
        )
      )}
    </div>
  );
}

function BasePromptPanel({ L, basePrompt, presets, presetNameDraft, actions }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div
        className="suno-panel-title"
        style={{ marginBottom: open ? 12 : 0, cursor: 'pointer', justifyContent: 'space-between' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {L.titleCard_basePromptTitle}
        </span>
      </div>
      {open && (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.titleCard_basePromptGlobalHint}</div>
          <textarea className="suno-textarea" value={basePrompt || ''} onChange={(e) => actions.updateTitleCardBasePrompt(e.target.value)} />
          {!!presets.length && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.titleCard_presetsLabel}:</span>
              {presets.map((p) => (
                <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <button className="chip" onClick={() => actions.loadTitleCardBasePromptPreset(p.id)}>{p.name}</button>
                  <button
                    className="icon-btn" style={{ width: 20, height: 20 }}
                    title={L.titleCard_deletePresetTitle}
                    onClick={() => actions.deleteTitleCardBasePromptPreset(p.id)}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              className="field" style={{ flex: 1 }}
              value={presetNameDraft}
              onChange={(e) => actions.setPresetNameDraft(e.target.value)}
              placeholder={L.titleCard_savePresetPlaceholder}
            />
            <button
              className="btn btn-accent-soft" style={{ padding: '7px 12px', fontSize: 12.5, flexShrink: 0 }}
              onClick={() => { actions.saveTitleCardBasePromptPreset(presetNameDraft); actions.setPresetNameDraft(''); }}
              disabled={!presetNameDraft.trim()}
            >
              {L.titleCard_savePresetAction}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ReferencePicker({ L, projectId, candidates, onPick, onUpload, onClose }) {
  const fileInputRef = useRef(null);
  return (
    <div className="glass-card" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <button className="btn btn-accent-soft" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => fileInputRef.current?.click()}>
          <Upload size={12} />
          {L.titleCard_uploadReference}
        </button>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = '';
        }}
      />
      {candidates.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{L.titleCard_noCandidates}</div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxHeight: 220, overflowY: 'auto' }}>
          {candidates.map((path) => (
            <button
              key={path}
              style={{
                padding: 0, border: 'none', background: 'rgba(255,255,255,0.04)', cursor: 'pointer',
                width: 84, height: 84, flexShrink: 0,
              }}
              onClick={() => onPick(path)}
            >
              <img
                src={mediaUrl(`projects/${projectId}/${path}`)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 6 }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TitleCardStage({
  L, project,
  imageModel, imageModelTier, imageModelFavorites, imageModelSimpleFavorites, modelPrices,
  variantCount, aspectRatio, generating,
  textBlock, referenceSlots, variants, presetNameDraft,
  titleCardBasePrompt, titleCardBasePromptPresets,
  titleCardWishText, wishLoading, titleCardWishLibrary, lastDebug,
  isRecordingTitleCardWish, recordingSeconds, voiceSupported,
  elapsedSeconds, titleCardError, removingBgIds,
  posters, posterConstructorOpen, editingPoster, posterSaving, logos,
  actions,
}) {
  const [pickerSlot, setPickerSlot] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const tierFavorites = imageModelTier === 'simple' ? imageModelSimpleFavorites : imageModelFavorites;
  const activeWishIds = project.active_title_card_wish_ids || [];

  const candidates = [...new Set([
    ...project.scenes.flatMap((s) => (s.images || []).map((img) => img.file_path)),
    ...(project.reference_images || []),
  ])];

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.titleCardStageTitle}</div>
          <div className="stage-heading-subtitle">{L.titleCardStageSubtitle}</div>
        </div>
      </div>

      <BasePromptPanel
        L={L} basePrompt={titleCardBasePrompt} presets={titleCardBasePromptPresets}
        presetNameDraft={presetNameDraft} actions={actions}
      />

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="scene-prompt-label">{L.titleCard_textLabel}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.titleCard_textHint}</div>
        <textarea
          className="field" rows={4} style={{ resize: 'vertical' }}
          value={textBlock} onChange={(e) => actions.setTextBlock(e.target.value)}
        />
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title">
          <Sparkles size={16} color="#ff9d5c" />
          {L.titleCard_wishesTitle}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            className="field"
            value={titleCardWishText}
            onChange={(e) => actions.setTitleCardWishText(e.target.value)}
            placeholder={isRecordingTitleCardWish ? L.listening : L.titleCard_wishPlaceholder}
          />
          {voiceSupported && (
            <button
              className={`icon-btn${isRecordingTitleCardWish ? ' icon-btn-recording' : ''}`}
              style={{ width: 38, height: 38 }}
              onClick={() => actions.startVoice('titleCardWish')}
            >
              {isRecordingTitleCardWish ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <button
            className="btn btn-accent-soft" style={{ flexShrink: 0 }}
            onClick={actions.addTitleCardWish}
            disabled={wishLoading}
          >
            {wishLoading ? <Loader2 size={14} className="spin" /> : null}
            {L.apply}
          </button>
        </div>
        {wishLoading && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 8 }}>⏳ {L.titleCard_wishLoading}</div>
        )}
        {isRecordingTitleCardWish && (
          <div className="recording-banner" style={{ marginTop: 10 }}>
            <span className="recording-dot" />
            {L.recording} · {recordingSeconds}s
          </div>
        )}
        {!!titleCardWishLibrary?.length && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {sortByUseCount(titleCardWishLibrary).map((wish) => (
              <span key={wish.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <button
                  className={`chip${activeWishIds.includes(wish.id) ? ' is-active' : ''}`}
                  title={wish.text}
                  onClick={() => actions.toggleTitleCardWish(wish.id)}
                >
                  {wish.title}
                </button>
                <button
                  className="icon-btn" style={{ width: 20, height: 20 }}
                  title={L.wish_deleteTitle}
                  onClick={() => actions.onDeleteTitleCardWish(wish.id)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="scene-prompt-label">{L.titleCard_referencesLabel}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.titleCard_referencesHint}</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {referenceSlots.map((path, i) => (
            <div key={i} style={{ width: 126 }}>
              <div
                style={{
                  position: 'relative', width: 126, height: 126, borderRadius: 8, overflow: 'hidden',
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                {path ? (
                  <>
                    <img
                      src={mediaUrl(`projects/${project.id}/${path}`)} alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                    <button
                      className="icon-btn" style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20 }}
                      title={L.titleCard_removeReference}
                      onClick={() => actions.removeReferenceSlot(i)}
                    >
                      <X size={11} />
                    </button>
                  </>
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)' }}>
                    <Plus size={26} />
                  </div>
                )}
              </div>
              <button
                className="btn btn-accent-soft" style={{ width: '100%', marginTop: 6, padding: '5px 0', fontSize: 11, justifyContent: 'center' }}
                onClick={() => setPickerSlot(pickerSlot === i ? null : i)}
              >
                {L.titleCard_changeReference}
              </button>
            </div>
          ))}
        </div>
        {pickerSlot != null && (
          <ReferencePicker
            L={L} projectId={project.id} candidates={candidates}
            onPick={(path) => { actions.setReferenceSlot(pickerSlot, path); setPickerSlot(null); }}
            onUpload={(file) => { actions.uploadReferenceForSlot(pickerSlot, file); setPickerSlot(null); }}
            onClose={() => setPickerSlot(null)}
          />
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 2 }}>{L.imageModelTierLabel}:</span>
        <button className={`chip${imageModelTier === 'simple' ? ' is-active' : ''}`} onClick={() => actions.setImageModelTier('simple')}>
          {L.imageModelTier_simple}
        </button>
        <button className={`chip${imageModelTier === 'main' ? ' is-active' : ''}`} onClick={() => actions.setImageModelTier('main')}>
          {L.imageModelTier_main}
        </button>

        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10, marginRight: 2 }}>{L.imageModel}:</span>
        <ModelPicker
          favorites={tierFavorites} value={imageModel} onChange={actions.selectImageModel}
          emptyLabel={L.modelPickerEmpty} prices={modelPrices} L={L}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 2 }}>{L.aspectRatioLabel}:</span>
        {ASPECT_RATIOS.map((ratio) => (
          <button
            key={ratio} className={`chip${aspectRatio === ratio ? ' is-active' : ''}`}
            onClick={() => actions.setAspectRatio(ratio)}
          >
            {L[`aspectRatio_${ratio.replace(':', '_')}`]}
          </button>
        ))}

        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10, marginRight: 2 }}>{L.variantCountLabel}:</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setVariantCount(Math.max(1, variantCount - 1))}>
          <Minus size={12} />
        </button>
        <span style={{ fontSize: 13, minWidth: 16, textAlign: 'center' }}>{variantCount}</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setVariantCount(Math.min(4, variantCount + 1))}>
          <Plus size={12} />
        </button>
      </div>

      <div style={{ marginBottom: 18 }}>
        <button
          className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }}
          onClick={() => actions.onGenerate(titleCardBasePrompt)} disabled={generating}
        >
          {generating ? <Loader2 size={16} className="spin" /> : <ImagePlus size={16} />}
          {generating ? L.generatingTitleCard : L.generateTitleCard}
        </button>
        {generating && (
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 10 }}>
            ⏳ {L.generatingTitleCard} · {formatDuration(elapsedSeconds, L)}
          </div>
        )}
        {/* Sticks here (not just a toast) until the next generate() call
            clears it - a timeout/error must stay visible, not flash past. */}
        {!generating && titleCardError && (
          <div style={{ fontSize: 13, color: '#fca5a5', marginTop: 10 }}>⚠️ {titleCardError}</div>
        )}
      </div>

      <div className="scene-prompt-label" style={{ marginBottom: 10 }}>{L.titleCard_variantsLabel}</div>
      {variants.length === 0 ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>{L.titleCard_noVariantsYet}</div>
      ) : (
        <TitleCardGallery
          L={L} projectId={project.id} variants={variants}
          onExpand={(i) => setLightboxIndex(i)}
          onDelete={actions.onDelete} onSelectMain={actions.onSelectMain} onRate={actions.onRate}
          onRemoveBackground={actions.onRemoveBackground} removingBgIds={removingBgIds}
        />
      )}

      <ImageLightbox
        L={L} projectId={project.id}
        images={lightboxIndex == null ? [] : variants}
        initialIndex={lightboxIndex || 0}
        onClose={() => setLightboxIndex(null)}
      />

      <div style={{ marginTop: 24, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="scene-prompt-label">{L.poster_postersLabel}</div>
        <button
          className="btn btn-accent-soft" style={{ padding: '7px 14px', fontSize: 12.5 }}
          disabled={!variants.length}
          onClick={() => actions.openConstructor(null)}
        >
          <Layers size={13} />
          {L.poster_openConstructor}
        </button>
      </div>
      {!variants.length ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>{L.poster_needTitleCardFirst}</div>
      ) : posters.length === 0 ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>{L.poster_noPostersYet}</div>
      ) : (
        <PosterGallery
          L={L} projectId={project.id} posters={posters}
          onEdit={actions.openConstructor} onDelete={actions.deletePoster} onSelectMain={actions.selectMainPoster}
        />
      )}

      {posterConstructorOpen && (
        <PosterConstructor
          L={L} projectId={project.id} candidates={candidates} variants={variants} logos={logos || []}
          initialPoster={editingPoster} saving={posterSaving}
          onSave={actions.savePoster} onClose={actions.closeConstructor}
        />
      )}

      <DebugPanel L={L} lastDebug={lastDebug} />
    </>
  );
}

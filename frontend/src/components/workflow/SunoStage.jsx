import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, MessageSquare, Mic, MicOff, Sparkles, Zap } from 'lucide-react';
import ModelPicker from './ModelPicker.jsx';
import { buildSunoPromptPreview, groupPresetsByService } from '../../lib/sunoPrompt.js';
import { estimateCost, estimateTokensFromChars, formatCost } from '../../lib/pricing.js';

function BasePromptPanel({ L, sunoBasePrompt, sunoPromptPresets, actions }) {
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
          {L.suno_basePromptTitle}
          <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text-dim)' }}>
            · {(sunoBasePrompt || '').length} {L.suno_previewCharsLabel.toLowerCase()}
          </span>
        </span>
      </div>
      {open && (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.suno_basePromptGlobalHint}</div>
          {!!sunoPromptPresets?.length && groupPresetsByService(sunoPromptPresets).map(([service, presets]) => (
            <div key={service} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{service}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    className={`chip${sunoBasePrompt === preset.prompt ? ' is-active' : ''}`}
                    title={preset.description}
                    onClick={() => actions.updateSunoBasePrompt(preset.prompt)}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <textarea
            className="suno-textarea"
            value={sunoBasePrompt || ''}
            onChange={(e) => actions.updateSunoBasePrompt(e.target.value)}
          />
        </>
      )}
    </div>
  );
}

function PromptPreviewPanel({
  L, sunoBasePrompt, referenceExamples, skillPrompt, blocks, activeWishes, genModel, modelPrices,
}) {
  const [open, setOpen] = useState(false);
  const previewText = buildSunoPromptPreview({
    basePrompt: sunoBasePrompt, examples: referenceExamples, skillPrompt, blocks, activeWishes,
  });
  const tokens = estimateTokensFromChars(previewText);
  const price = genModel ? modelPrices?.[genModel] : null;
  const cost = price ? estimateCost(price, { inputTokens: tokens }) : null;

  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div
        className="suno-panel-title"
        style={{ marginBottom: open ? 12 : 0, cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {L.suno_previewTitle}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dim)' }}>
        <span>{L.suno_previewCharsLabel}: {previewText.length}</span>
        <span>{L.suno_previewTokensLabel}: {tokens}</span>
        <span>
          {L.suno_previewCostLabel}: {genModel ? `${formatCost(cost)} (${L.suno_previewCostHint})` : L.suno_previewNoModel}
        </span>
      </div>
      {open && (
        <pre
          style={{
            marginTop: 12, marginBottom: 0, fontFamily: "'SF Mono',monospace", fontSize: 12,
            color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 420, overflowY: 'auto',
          }}
        >
          {previewText}
        </pre>
      )}
    </div>
  );
}

export default function SunoStage({
  L, project, refinementText, isRecordingRefinement, recordingSeconds, voiceSupported,
  sunoLoading, trackUrl, wishLibrary, genModel, simpleModelDefault, simpleModelFavorites, textModelFavorites,
  modelPrices, sunoBasePrompt, sunoPromptPresets, referenceExamples, actions,
}) {
  const wishModelEntry = simpleModelFavorites?.find((f) => `${f.provider}:${f.id}` === simpleModelDefault);
  const wishModelLabel = wishModelEntry ? wishModelEntry.label : (simpleModelDefault || L.suno_wishModelNotSet);
  const activeWishIds = project.active_wish_ids || [];
  const activeWishes = (wishLibrary || []).filter((w) => activeWishIds.includes(w.id)).map((w) => w.text);

  return (
    <>
      <div className="stage-heading-title" style={{ marginBottom: 4 }}>{L.sunoStageTitle}</div>
      <div className="stage-heading-subtitle" style={{ marginBottom: 18 }}>{L.sunoStageSubtitle}</div>

      <BasePromptPanel L={L} sunoBasePrompt={sunoBasePrompt} sunoPromptPresets={sunoPromptPresets} actions={actions} />

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title">
          <Sparkles size={16} color="#ff9d5c" />
          {L.selectedSkill}
        </div>
        <textarea
          className="suno-textarea"
          value={project.skill_prompt}
          onChange={(e) => actions.setSkillPrompt(e.target.value)}
        />
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title">
          <MessageSquare size={16} color="#ff9d5c" />
          {L.refinement}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            className="field"
            value={refinementText}
            onChange={(e) => actions.setRefinementText(e.target.value)}
            placeholder={isRecordingRefinement ? L.listening : L.refinementPlaceholder}
          />
          {voiceSupported && (
            <button
              className={`icon-btn${isRecordingRefinement ? ' icon-btn-recording' : ''}`}
              style={{ width: 38, height: 38 }}
              onClick={() => actions.startVoice('refinement')}
            >
              {isRecordingRefinement ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <button className="btn btn-accent-soft" style={{ flexShrink: 0 }} onClick={actions.addWish}>
            {L.apply}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>
          {L.suno_wishModelLabel}: {wishModelLabel} · {L.suno_wishModelHint}
        </div>
        {!!wishLibrary?.length && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {wishLibrary.map((wish) => (
              <button
                key={wish.id}
                className={`chip${activeWishIds.includes(wish.id) ? ' is-active' : ''}`}
                title={wish.text}
                onClick={() => actions.toggleWish(wish.id)}
              >
                {wish.title}
              </button>
            ))}
          </div>
        )}
        {isRecordingRefinement && (
          <div className="recording-banner" style={{ marginTop: 10 }}>
            <span className="recording-dot" />
            {L.recording} · {recordingSeconds}s
          </div>
        )}
      </div>

      <PromptPreviewPanel
        L={L} sunoBasePrompt={sunoBasePrompt} referenceExamples={referenceExamples}
        skillPrompt={project.skill_prompt} blocks={project.blocks} activeWishes={activeWishes}
        genModel={genModel} modelPrices={modelPrices}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <button className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }} onClick={actions.generateSuno}>
          <Zap size={16} />
          {L.generateForSuno}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.suno_genModelLabel}:</span>
        <ModelPicker
          favorites={textModelFavorites}
          value={genModel}
          onChange={actions.selectGenModel}
          emptyLabel={L.modelPickerEmpty}
          prices={modelPrices}
          L={L}
        />
      </div>

      {sunoLoading && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>⏳ {L.generatingSuno}</div>
      )}

      {!!project.style && (
        <>
          <div className="glass-card" style={{ marginBottom: 12 }}>
            <div className="result-panel-header">
              <span className="result-panel-label">{L.styleOfMusic}</span>
              <button className="result-panel-copy" onClick={actions.copyStyle}>
                <Copy size={12} />
                {L.copyStyle}
              </button>
            </div>
            <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>{project.style}</div>
          </div>

          <div className="glass-card" style={{ marginBottom: 16 }}>
            <div className="result-panel-header">
              <span className="result-panel-label">{L.songLyrics}</span>
              <button className="result-panel-copy" onClick={actions.copyLyrics}>
                <Copy size={12} />
                {L.copyLyrics}
              </button>
            </div>
            <pre style={{ margin: 0, fontFamily: "'SF Mono',monospace", fontSize: 12.5, color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
              {project.lyrics}
            </pre>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="field"
              value={trackUrl}
              onChange={(e) => actions.setTrackUrl(e.target.value)}
              placeholder={L.trackUrlPlaceholder}
            />
            <button
              className="btn"
              style={{ background: 'rgba(74,222,128,0.14)', border: '1px solid rgba(74,222,128,0.3)', color: '#86efac', fontWeight: 700 }}
              onClick={actions.saveTrackUrl}
            >
              {L.saveLink}
            </button>
          </div>
        </>
      )}
    </>
  );
}

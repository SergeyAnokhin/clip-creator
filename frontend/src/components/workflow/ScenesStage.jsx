import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Mic, MicOff, Minus, Plus, Sparkles, Zap } from 'lucide-react';
import SceneTextCard from './SceneTextCard.jsx';
import ModelPicker from './ModelPicker.jsx';
import { formatCost, formatTokens } from '../../lib/pricing.js';

/** `12с` / `1м 05с` (or the EN `12s` / `1m 05s`) - shared unit labels with
 * SunoStage.jsx's own formatDuration, reused here rather than duplicated
 * under a new key. */
function formatDuration(totalSeconds, L) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}${L.suno_unitSeconds}`;
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}${L.suno_unitMinutes} ${rem}${L.suno_unitSeconds}`;
}

function BasePromptPanel({ L, sceneMode, basePromptNarrative, basePromptAbstract, actions }) {
  const [open, setOpen] = useState(false);
  const value = sceneMode === 'abstract' ? basePromptAbstract : basePromptNarrative;
  const onChange = sceneMode === 'abstract' ? actions.updateSceneBasePromptAbstract : actions.updateSceneBasePromptNarrative;
  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div
        className="suno-panel-title"
        style={{ marginBottom: open ? 12 : 0, cursor: 'pointer', justifyContent: 'space-between' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {L.scene_basePromptTitle}
          <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text-dim)' }}>
            · {L[`sceneMode_${sceneMode}`]} · {(value || '').length} {L.suno_previewCharsLabel.toLowerCase()}
          </span>
        </span>
      </div>
      {open && (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 10 }}>{L.scene_basePromptGlobalHint}</div>
          <textarea className="suno-textarea" value={value || ''} onChange={(e) => onChange(e.target.value)} />
        </>
      )}
    </div>
  );
}

function UsageSummaryLine({ L, usage, completedAt }) {
  if (!usage) return null;
  const { input_tokens, output_tokens, duration_ms, cost } = usage;
  const isEstimate = cost?.amount != null && cost.source !== 'provider';
  const costText = `${isEstimate ? '≈' : ''}${formatCost(cost?.amount)}`;
  const timeText = completedAt
    ? new Date(completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
      <span title={L.scene_debugUsageTokens}>🔤 {formatTokens(input_tokens)}→{formatTokens(output_tokens)}</span>
      <span title={L.scene_debugUsageCost}>💰 {costText}</span>
      {timeText && <span title={L.scene_debugUsageTime}>🕐 {timeText}</span>}
      {duration_ms != null && <span title={L.scene_debugUsageTime}>⏱ {formatDuration(duration_ms / 1000, L)}</span>}
    </div>
  );
}

function stubMessage(L, debug) {
  const model = debug.requested_model || '';
  const key = `scene_debugReason_${debug.reason}`;
  return (L[key] || L.scene_debugReason_no_model_selected).replace('{model}', model);
}

function DebugPanel({ L, lastDebug }) {
  const [open, setOpen] = useState(false);
  const needsAttention = !!(lastDebug?.stub || lastDebug?.missing_markers);
  const hasUsage = !lastDebug?.stub && !!lastDebug?.usage;
  useEffect(() => {
    if (needsAttention) setOpen(true);
  }, [lastDebug, needsAttention]);

  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div
        className="suno-panel-title"
        style={{ marginBottom: (open || hasUsage) ? 12 : 0, cursor: 'pointer', justifyContent: 'space-between' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {L.scene_debugTitle}
        </span>
        {!open && needsAttention && <span style={{ fontSize: 12 }}>⚠️</span>}
      </div>
      {hasUsage && <UsageSummaryLine L={L} usage={lastDebug.usage} completedAt={lastDebug.completedAt} />}
      {open && (
        !lastDebug ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.scene_debugNoData}</div>
        ) : (
          <>
            {lastDebug.stub && (
              <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 10 }}>⚠️ {stubMessage(L, lastDebug)}</div>
            )}
            {!lastDebug.stub && lastDebug.missing_markers && (
              <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 10 }}>{L.scene_debugMissingBlocks}</div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{L.scene_debugRequestLabel}</div>
            <pre
              style={{
                margin: 0, marginBottom: 12, fontFamily: "'SF Mono',monospace", fontSize: 11.5,
                color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.6, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {JSON.stringify(lastDebug.stub
                ? { stub: true, reason: lastDebug.reason, requested_model: lastDebug.requested_model }
                : lastDebug.request, null, 2)}
            </pre>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{L.scene_debugResponseLabel}</div>
            <pre
              style={{
                margin: 0, fontFamily: "'SF Mono',monospace", fontSize: 11.5,
                color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.6, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {JSON.stringify(lastDebug.stub
                ? { stub: true, reason: lastDebug.reason, requested_model: lastDebug.requested_model }
                : lastDebug.response, null, 2)}
            </pre>
          </>
        )
      )}
    </div>
  );
}

export default function ScenesStage({
  L, project, isMobile, sceneTextModel, textModelFavorites, modelPrices,
  sceneImageModel, sceneImageModelFavorites, sceneImageLoadingIdx,
  sceneMode, sceneCount, styleDescription, sceneWishText, storyboardLoading, wishLoading, elapsedSeconds, sceneError, lastDebug,
  sceneWishLibrary, sceneBasePromptNarrative, sceneBasePromptAbstract, hideMotionPrompt,
  sceneRecordingIdx, isRecordingSceneWish, recordingSeconds, voiceSupported, actions,
}) {
  const activeWishIds = project.active_scene_wish_ids || [];

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.scenesStageTitle}</div>
          <div className="stage-heading-subtitle">{L.scenesStageSubtitle}</div>
        </div>
      </div>

      <BasePromptPanel
        L={L} sceneMode={sceneMode} basePromptNarrative={sceneBasePromptNarrative} basePromptAbstract={sceneBasePromptAbstract}
        actions={actions}
      />

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="suno-panel-title">
          <Sparkles size={16} color="#ff9d5c" />
          {L.scene_wishesTitle}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            className="field"
            value={sceneWishText}
            onChange={(e) => actions.setSceneWishText(e.target.value)}
            placeholder={isRecordingSceneWish ? L.listening : L.scene_wishPlaceholder}
          />
          {voiceSupported && (
            <button
              className={`icon-btn${isRecordingSceneWish ? ' icon-btn-recording' : ''}`}
              style={{ width: 38, height: 38 }}
              onClick={() => actions.startVoice('sceneWish')}
            >
              {isRecordingSceneWish ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <button
            className="btn btn-accent-soft" style={{ flexShrink: 0 }}
            onClick={actions.addSceneWish}
            disabled={wishLoading}
          >
            {wishLoading ? <Loader2 size={14} className="spin" /> : null}
            {L.apply}
          </button>
        </div>
        {wishLoading && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 8 }}>⏳ {L.scene_wishLoading}</div>
        )}
        {isRecordingSceneWish && (
          <div className="recording-banner" style={{ marginTop: 10 }}>
            <span className="recording-dot" />
            {L.recording} · {recordingSeconds}s
          </div>
        )}
        {!!sceneWishLibrary?.length && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {sceneWishLibrary.map((wish) => (
              <button
                key={wish.id}
                className={`chip${activeWishIds.includes(wish.id) ? ' is-active' : ''}`}
                title={wish.text}
                onClick={() => actions.toggleSceneWish(wish.id)}
              >
                {wish.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div className="scene-prompt-label">{L.styleDescriptionLabel}</div>
        <textarea
          className="scene-textarea"
          value={styleDescription}
          placeholder={L.styleDescriptionPlaceholder}
          onChange={(e) => actions.onStyleDescriptionChange(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginRight: 2 }}>{L.sceneModeLabel}:</span>
        <button className={`chip${sceneMode === 'narrative' ? ' is-active' : ''}`} onClick={() => actions.setSceneMode('narrative')}>
          {L.sceneMode_narrative}
        </button>
        <button className={`chip${sceneMode === 'abstract' ? ' is-active' : ''}`} onClick={() => actions.setSceneMode('abstract')}>
          {L.sceneMode_abstract}
        </button>

        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10, marginRight: 2 }}>{L.sceneCountLabel}:</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setSceneCount(Math.max(1, sceneCount - 1))}>
          <Minus size={12} />
        </button>
        <span style={{ fontSize: 13, minWidth: 20, textAlign: 'center' }}>{sceneCount}</span>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => actions.setSceneCount(Math.min(30, sceneCount + 1))}>
          <Plus size={12} />
        </button>

        <button
          className={`chip${hideMotionPrompt ? ' is-active' : ''}`} style={{ marginLeft: 10 }}
          onClick={() => actions.setHideMotionPrompt(!hideMotionPrompt)}
        >
          {L.hideMotionPromptLabel}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <button
          className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }}
          onClick={actions.generateStoryboard} disabled={storyboardLoading}
        >
          {storyboardLoading ? <Loader2 size={16} className="spin" /> : <Zap size={16} />}
          {storyboardLoading ? L.generatingStoryboard : L.generateStoryboard}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.scene_genModelLabel}:</span>
        <ModelPicker
          favorites={textModelFavorites}
          value={sceneTextModel}
          onChange={actions.selectSceneTextModel}
          emptyLabel={L.modelPickerEmpty}
          prices={modelPrices}
          L={L}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.sceneImageModelLabel}:</span>
        <ModelPicker
          favorites={sceneImageModelFavorites}
          value={sceneImageModel}
          onChange={actions.selectSceneImageModel}
          emptyLabel={L.modelPickerEmpty}
          prices={modelPrices}
          L={L}
        />
      </div>

      {storyboardLoading && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
          ⏳ {L.generatingStoryboard} · {formatDuration(elapsedSeconds, L)}
        </div>
      )}
      {!storyboardLoading && sceneError && (
        <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 16 }}>⚠️ {sceneError}</div>
      )}

      <DebugPanel L={L} lastDebug={lastDebug} />

      {project.scenes.length === 0 ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {L.noStoryboardYet}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {project.scenes.map((scene, index) => (
            <SceneTextCard
              key={index}
              L={L}
              projectId={project.id}
              index={index}
              scene={scene}
              isRecording={sceneRecordingIdx === index}
              recordingSeconds={recordingSeconds}
              voiceSupported={voiceSupported}
              columns={isMobile ? '1fr' : hideMotionPrompt ? '1fr' : '1fr 1fr'}
              hideMotionPrompt={hideMotionPrompt}
              isImageLoading={sceneImageLoadingIdx === index}
              actions={actions}
            />
          ))}
        </div>
      )}
    </>
  );
}

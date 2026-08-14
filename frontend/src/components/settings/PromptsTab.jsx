import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { groupPresetsByService } from '../../lib/sunoPrompt.js';
import { pickReadableTextColor } from '../../lib/musicTagColors.js';
import BasePromptPresetEditor from './BasePromptPresetEditor.jsx';

// Settings > "Prompts": the two tag lists (Suno special tags, Mureka music
// tags), the read-only Suno/Mureka preset list, the user-managed preset
// editors, the three base prompts, and the Suno reference examples.
export default function PromptsTab({
  L, specialTags, musicTags, sunoPromptPresets, sunoBasePrompt,
  sunoBasePromptUserPresets, murekaBasePromptUserPresets,
  sceneBasePromptNarrative, sceneBasePromptAbstract, referenceExamples, actions,
}) {
  const [newTagDraft, setNewTagDraft] = useState('');
  const [editingTagIndex, setEditingTagIndex] = useState(null);
  const [newMusicTagDraft, setNewMusicTagDraft] = useState('');
  const [editingMusicTagId, setEditingMusicTagId] = useState(null);
  const [newExampleDraft, setNewExampleDraft] = useState('');
  const [editingExampleIndex, setEditingExampleIndex] = useState(null);

  function startEditTag(index) {
    setEditingTagIndex(index);
    setNewTagDraft(specialTags[index]);
  }
  function cancelEditTag() {
    setEditingTagIndex(null);
    setNewTagDraft('');
  }
  function submitTagDraft() {
    if (editingTagIndex !== null) {
      actions.updateSpecialTag(editingTagIndex, newTagDraft);
    } else {
      actions.addSpecialTag(newTagDraft);
    }
    setEditingTagIndex(null);
    setNewTagDraft('');
  }

  function startEditMusicTag(tag) {
    setEditingMusicTagId(tag.id);
    setNewMusicTagDraft(tag.label);
  }
  function cancelEditMusicTag() {
    setEditingMusicTagId(null);
    setNewMusicTagDraft('');
  }
  function submitMusicTagDraft() {
    if (editingMusicTagId !== null) {
      actions.updateMusicTag(editingMusicTagId, newMusicTagDraft);
    } else {
      actions.addMusicTag(newMusicTagDraft);
    }
    setEditingMusicTagId(null);
    setNewMusicTagDraft('');
  }

  function startEditExample(index) {
    setEditingExampleIndex(index);
    setNewExampleDraft(referenceExamples[index]);
  }
  function cancelEditExample() {
    setEditingExampleIndex(null);
    setNewExampleDraft('');
  }
  function submitExampleDraft() {
    if (editingExampleIndex !== null) {
      actions.updateReferenceExample(editingExampleIndex, newExampleDraft);
    } else {
      actions.addReferenceExample(newExampleDraft);
    }
    setEditingExampleIndex(null);
    setNewExampleDraft('');
  }

  return (
    <>
      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_specialTags}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {specialTags.map((tag, i) => (
            <div
              className="settings-row"
              key={i}
              style={i === editingTagIndex ? { background: 'rgba(255,255,255,0.06)', borderRadius: 8, margin: '0 -6px', padding: '4px 6px' } : undefined}
            >
              <span
                className="settings-row-name"
                style={{ width: 'auto', flex: 1, cursor: 'pointer' }}
                title={L.settings_clickToEdit}
                onClick={() => startEditTag(i)}
              >
                {tag}
              </span>
              <button className="icon-btn icon-btn-danger" onClick={() => actions.removeSpecialTag(i)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            className="field"
            value={newTagDraft}
            onChange={(e) => setNewTagDraft(e.target.value)}
            placeholder={L.settings_specialTagsPlaceholder}
          />
          <button className="btn btn-accent-soft" onClick={submitTagDraft}>
            {editingTagIndex !== null ? L.save : L.add}
          </button>
          {editingTagIndex !== null && (
            <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditTag}>
              {L.cancel}
            </button>
          )}
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_musicTags}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{L.settings_musicTagsHint}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {musicTags.map((tag) => (
            <div
              className="settings-row"
              key={tag.id}
              style={tag.id === editingMusicTagId ? { background: 'rgba(255,255,255,0.06)', borderRadius: 8, margin: '0 -6px', padding: '4px 6px' } : undefined}
            >
              <span
                className="chip"
                style={{
                  padding: '4px 12px', fontSize: 12.5, cursor: 'pointer',
                  background: tag.color || 'rgba(255,255,255,0.06)', color: pickReadableTextColor(tag.color),
                  border: 'none',
                }}
                title={L.settings_clickToEdit}
                onClick={() => startEditMusicTag(tag)}
              >
                {tag.label}
              </span>
              <button className="icon-btn icon-btn-danger" onClick={() => actions.removeMusicTag(tag.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            className="field"
            value={newMusicTagDraft}
            onChange={(e) => setNewMusicTagDraft(e.target.value)}
            placeholder={L.settings_musicTagsPlaceholder}
          />
          <button className="btn btn-accent-soft" onClick={submitMusicTagDraft}>
            {editingMusicTagId !== null ? L.save : L.add}
          </button>
          {editingMusicTagId !== null && (
            <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditMusicTag}>
              {L.cancel}
            </button>
          )}
        </div>
      </div>

      {sunoPromptPresets.length > 0 && (
        <div className="settings-panel">
          <div className="settings-panel-label">{L.settings_sunoPromptPresets}</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{L.settings_sunoPromptPresetsHint}</div>
          {groupPresetsByService(sunoPromptPresets).map(([service, presets]) => (
            <div key={service} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>{service}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {presets.map((preset) => {
                  const isActive = sunoBasePrompt === preset.prompt;
                  return (
                    <div className="settings-row" key={preset.id} style={{ alignItems: 'flex-start' }}>
                      <div>
                        <div className="settings-row-name">{preset.name}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>{preset.description}</div>
                      </div>
                      <button
                        className={`btn btn-accent-soft${isActive ? ' is-active' : ''}`}
                        style={{ flexShrink: 0 }}
                        onClick={() => actions.setSunoBasePrompt(preset.prompt)}
                      >
                        {isActive ? L.settings_presetLoaded : L.settings_loadPreset}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <BasePromptPresetEditor
        L={L} title={L.settings_sunoUserPresets} hint={L.settings_sunoUserPresetsHint}
        presets={sunoBasePromptUserPresets}
        onSave={actions.saveSunoBasePromptUserPreset}
        onUpdate={actions.updateSunoBasePromptUserPreset}
        onDelete={actions.deleteSunoBasePromptUserPreset}
      />
      <BasePromptPresetEditor
        L={L} title={L.settings_murekaUserPresets} hint={L.settings_murekaUserPresetsHint}
        presets={murekaBasePromptUserPresets}
        onSave={actions.saveMurekaBasePromptUserPreset}
        onUpdate={actions.updateMurekaBasePromptUserPreset}
        onDelete={actions.deleteMurekaBasePromptUserPreset}
      />

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_sunoBasePrompt}</div>
        <textarea
          className="suno-textarea"
          style={{ minHeight: 180 }}
          value={sunoBasePrompt}
          onChange={(e) => actions.setSunoBasePrompt(e.target.value)}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_sceneBasePromptNarrative}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>{L.settings_sceneBasePromptNarrativeHint}</div>
        <textarea
          className="suno-textarea"
          style={{ minHeight: 180 }}
          value={sceneBasePromptNarrative}
          onChange={(e) => actions.updateSceneBasePromptNarrative(e.target.value)}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_sceneBasePromptAbstract}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>{L.settings_sceneBasePromptAbstractHint}</div>
        <textarea
          className="suno-textarea"
          style={{ minHeight: 180 }}
          value={sceneBasePromptAbstract}
          onChange={(e) => actions.updateSceneBasePromptAbstract(e.target.value)}
        />
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_referenceExamples}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {referenceExamples.map((example, i) => (
            <div
              className="settings-row"
              key={i}
              style={i === editingExampleIndex ? { background: 'rgba(255,255,255,0.06)', borderRadius: 8, margin: '0 -6px', padding: '4px 6px' } : undefined}
            >
              <span
                className="settings-row-name"
                style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                title={L.settings_clickToEdit}
                onClick={() => startEditExample(i)}
              >
                {example}
              </span>
              <button className="icon-btn icon-btn-danger" onClick={() => actions.removeReferenceExample(i)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          <textarea
            className="suno-textarea"
            style={{ minHeight: 80 }}
            value={newExampleDraft}
            onChange={(e) => setNewExampleDraft(e.target.value)}
            placeholder={L.settings_referenceExamplesPlaceholder}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-accent-soft" style={{ alignSelf: 'flex-start' }} onClick={submitExampleDraft}>
              {editingExampleIndex !== null ? L.save : L.add}
            </button>
            {editingExampleIndex !== null && (
              <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditExample}>
                {L.cancel}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

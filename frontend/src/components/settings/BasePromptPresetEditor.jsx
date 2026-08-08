import { useState } from 'react';
import { Trash2 } from 'lucide-react';

/** Named-prompt-snippet list editor (name + prompt text, add/rename/delete) -
 * used twice on the "Музыкальные промпты" settings tab (Suno and Mureka user
 * presets, see useSettings.js's save/update/delete*BasePromptUserPreset),
 * same uniform presentation for both. Unlike the read-only built-in presets
 * panel above it, these are entered directly here rather than "save what's
 * currently in the base-prompt textarea" - there's one base-prompt field but
 * two preset lists (Suno/Mureka), so a shared "current text" would be
 * ambiguous. */
export default function BasePromptPresetEditor({ L, title, hint, presets, onSave, onUpdate, onDelete }) {
  const [nameDraft, setNameDraft] = useState('');
  const [promptDraft, setPromptDraft] = useState('');
  const [editingId, setEditingId] = useState(null);

  function startEdit(preset) {
    setEditingId(preset.id);
    setNameDraft(preset.name);
    setPromptDraft(preset.prompt);
  }
  function cancelEdit() {
    setEditingId(null);
    setNameDraft('');
    setPromptDraft('');
  }
  function submit() {
    if (!nameDraft.trim() || !promptDraft.trim()) return;
    if (editingId) onUpdate(editingId, { name: nameDraft, prompt: promptDraft });
    else onSave(nameDraft, promptDraft);
    cancelEdit();
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-label">{title}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{hint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {presets.map((preset) => (
          <div
            className="settings-row"
            key={preset.id}
            style={preset.id === editingId ? { background: 'rgba(255,255,255,0.06)', borderRadius: 8, margin: '0 -6px', padding: '4px 6px' } : undefined}
          >
            <span
              className="settings-row-name"
              style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
              title={L.settings_clickToEdit}
              onClick={() => startEdit(preset)}
            >
              {preset.name}
            </span>
            <button className="icon-btn icon-btn-danger" onClick={() => onDelete(preset.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
        <input
          className="field" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
          placeholder={L.settings_basePromptPresetNamePlaceholder}
        />
        <textarea
          className="suno-textarea" style={{ minHeight: 100 }} value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)} placeholder={L.settings_basePromptPresetTextPlaceholder}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-accent-soft" style={{ alignSelf: 'flex-start' }} onClick={submit}>
            {editingId ? L.save : L.add}
          </button>
          {editingId && (
            <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEdit}>
              {L.cancel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

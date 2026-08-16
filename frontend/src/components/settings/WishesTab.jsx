import { useState } from 'react';
import { Mic, MicOff, Pencil, Trash2 } from 'lucide-react';
import { sortByUseCount } from '../../lib/wishes.js';
import { focusOnMount } from '../../lib/a11y.js';
import { useFieldVoice } from '../../hooks/useVoice.js';

// Settings > "Wishes": the three separate wish libraries (music/lyrics,
// scenes, video). Only the music one has voice input on its fields - the
// other two are plain text, same as before this tab was split out.
export default function WishesTab({ L, lang, showToast, wishLibrary, sceneWishLibrary, videoWishLibrary, actions }) {
  const wishVoice = useFieldVoice({ showToast, L, lang });

  const [newWishDraft, setNewWishDraft] = useState('');
  const [editingWishId, setEditingWishId] = useState(null);
  const [editWishTitle, setEditWishTitle] = useState('');
  const [editWishText, setEditWishText] = useState('');

  const [newSceneWishDraft, setNewSceneWishDraft] = useState('');
  const [editingSceneWishId, setEditingSceneWishId] = useState(null);
  const [editSceneWishTitle, setEditSceneWishTitle] = useState('');
  const [editSceneWishText, setEditSceneWishText] = useState('');

  const [newVideoWishDraft, setNewVideoWishDraft] = useState('');
  const [editingVideoWishId, setEditingVideoWishId] = useState(null);
  const [editVideoWishTitle, setEditVideoWishTitle] = useState('');
  const [editVideoWishText, setEditVideoWishText] = useState('');

  function startEditWish(wish) {
    setEditingWishId(wish.id);
    setEditWishTitle(wish.title);
    setEditWishText(wish.text);
  }
  function cancelEditWish() {
    setEditingWishId(null);
  }
  function saveEditWish() {
    const title = editWishTitle.trim();
    const text = editWishText.trim();
    if (!title || !text) return;
    actions.updateWishSnippet(editingWishId, { title, text });
    setEditingWishId(null);
  }

  function startEditSceneWish(wish) {
    setEditingSceneWishId(wish.id);
    setEditSceneWishTitle(wish.title);
    setEditSceneWishText(wish.text);
  }
  function cancelEditSceneWish() {
    setEditingSceneWishId(null);
  }
  function saveEditSceneWish() {
    const title = editSceneWishTitle.trim();
    const text = editSceneWishText.trim();
    if (!title || !text) return;
    actions.updateSceneWishSnippet(editingSceneWishId, { title, text });
    setEditingSceneWishId(null);
  }

  function startEditVideoWish(wish) {
    setEditingVideoWishId(wish.id);
    setEditVideoWishTitle(wish.title);
    setEditVideoWishText(wish.text);
  }
  function cancelEditVideoWish() {
    setEditingVideoWishId(null);
  }
  function saveEditVideoWish() {
    const title = editVideoWishTitle.trim();
    const text = editVideoWishText.trim();
    if (!title || !text) return;
    actions.updateVideoWishSnippet(editingVideoWishId, { title, text });
    setEditingVideoWishId(null);
  }

  return (
    <>
      <div className="settings-panel">
        <div className="settings-panel-label">{L.settings_wishLibrary}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sortByUseCount(wishLibrary).map((wish) => (
            editingWishId === wish.id ? (
              <div className="settings-panel" style={{ padding: 12 }} key={wish.id}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    className="field"
                    value={editWishTitle}
                    onChange={(e) => setEditWishTitle(e.target.value)}
                    placeholder={L.settings_wishLibraryTitleLabel}
                    ref={focusOnMount}
                  />
                  {wishVoice.isSupported && (
                    <button
                      className={`icon-btn${wishVoice.recordingField === `wish-title-${wish.id}` ? ' icon-btn-recording' : ''}`}
                      style={{ width: 38, height: 38, flexShrink: 0 }}
                      title={L.voiceEdit}
                      onClick={() => wishVoice.startFieldVoice(`wish-title-${wish.id}`, (t) => setEditWishTitle(t))}
                    >
                      {wishVoice.recordingField === `wish-title-${wish.id}` ? <MicOff size={15} /> : <Mic size={15} />}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <textarea
                    className="suno-textarea"
                    style={{ minHeight: 70, flex: 1 }}
                    value={editWishText}
                    onChange={(e) => setEditWishText(e.target.value)}
                    placeholder={L.settings_wishLibraryTextLabel}
                  />
                  {wishVoice.isSupported && (
                    <button
                      className={`icon-btn${wishVoice.recordingField === `wish-text-${wish.id}` ? ' icon-btn-recording' : ''}`}
                      style={{ width: 38, height: 38, flexShrink: 0 }}
                      title={L.voiceEdit}
                      onClick={() => wishVoice.startFieldVoice(`wish-text-${wish.id}`, (t) => setEditWishText((prev) => (prev ? `${prev}\n${t}` : t)))}
                    >
                      {wishVoice.recordingField === `wish-text-${wish.id}` ? <MicOff size={15} /> : <Mic size={15} />}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-gradient" style={{ padding: '6px 16px' }} onClick={saveEditWish}>{L.save}</button>
                  <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditWish}>{L.cancel}</button>
                </div>
              </div>
            ) : (
              <div className="settings-row" key={wish.id} title={wish.text}>
                <span className="settings-row-name" style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {wish.title}
                </span>
                <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.settings_wishLibraryEdit} onClick={() => startEditWish(wish)}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn icon-btn-danger" onClick={() => actions.removeWishSnippet(wish.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            className="field"
            value={newWishDraft}
            onChange={(e) => setNewWishDraft(e.target.value)}
            placeholder={wishVoice.recordingField === 'wish-draft' ? L.listening : L.settings_wishLibraryPlaceholder}
          />
          {wishVoice.isSupported && (
            <button
              className={`icon-btn${wishVoice.recordingField === 'wish-draft' ? ' icon-btn-recording' : ''}`}
              style={{ width: 38, height: 38, flexShrink: 0 }}
              title={L.voiceEdit}
              onClick={() => wishVoice.startFieldVoice('wish-draft', (t) => setNewWishDraft((prev) => (prev ? `${prev} ${t}` : t)))}
            >
              {wishVoice.recordingField === 'wish-draft' ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <button
            className="btn btn-accent-soft"
            onClick={() => { actions.saveWishToLibrary(newWishDraft); setNewWishDraft(''); }}
          >
            {L.add}
          </button>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.scene_wishesTitle}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sortByUseCount(sceneWishLibrary).map((wish) => (
            editingSceneWishId === wish.id ? (
              <div className="settings-panel" style={{ padding: 12 }} key={wish.id}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    className="field"
                    value={editSceneWishTitle}
                    onChange={(e) => setEditSceneWishTitle(e.target.value)}
                    placeholder={L.settings_wishLibraryTitleLabel}
                    ref={focusOnMount}
                  />
                </div>
                <textarea
                  className="suno-textarea"
                  style={{ minHeight: 70 }}
                  value={editSceneWishText}
                  onChange={(e) => setEditSceneWishText(e.target.value)}
                  placeholder={L.settings_wishLibraryTextLabel}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-gradient" style={{ padding: '6px 16px' }} onClick={saveEditSceneWish}>{L.save}</button>
                  <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditSceneWish}>{L.cancel}</button>
                </div>
              </div>
            ) : (
              <div className="settings-row" key={wish.id} title={wish.text}>
                <span className="settings-row-name" style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {wish.title}
                </span>
                <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.settings_wishLibraryEdit} onClick={() => startEditSceneWish(wish)}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn icon-btn-danger" onClick={() => actions.removeSceneWishSnippet(wish.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            className="field"
            value={newSceneWishDraft}
            onChange={(e) => setNewSceneWishDraft(e.target.value)}
            placeholder={L.scene_wishPlaceholder}
          />
          <button
            className="btn btn-accent-soft"
            onClick={() => { actions.saveSceneWishToLibrary(newSceneWishDraft); setNewSceneWishDraft(''); }}
          >
            {L.add}
          </button>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-panel-label">{L.video_wishesTitle}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sortByUseCount(videoWishLibrary).map((wish) => (
            editingVideoWishId === wish.id ? (
              <div className="settings-panel" style={{ padding: 12 }} key={wish.id}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    className="field"
                    value={editVideoWishTitle}
                    onChange={(e) => setEditVideoWishTitle(e.target.value)}
                    placeholder={L.settings_wishLibraryTitleLabel}
                    ref={focusOnMount}
                  />
                </div>
                <textarea
                  className="suno-textarea"
                  style={{ minHeight: 70 }}
                  value={editVideoWishText}
                  onChange={(e) => setEditVideoWishText(e.target.value)}
                  placeholder={L.settings_wishLibraryTextLabel}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-gradient" style={{ padding: '6px 16px' }} onClick={saveEditVideoWish}>{L.save}</button>
                  <button className="btn-ghost" style={{ padding: '6px 16px', borderRadius: 8, border: 'none', cursor: 'pointer' }} onClick={cancelEditVideoWish}>{L.cancel}</button>
                </div>
              </div>
            ) : (
              <div className="settings-row" key={wish.id} title={wish.text}>
                <span className="settings-row-name" style={{ width: 'auto', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {wish.title}
                </span>
                <button className="icon-btn" style={{ width: 30, height: 30, opacity: 0.75 }} title={L.settings_wishLibraryEdit} onClick={() => startEditVideoWish(wish)}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn icon-btn-danger" onClick={() => actions.removeVideoWishSnippet(wish.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            className="field"
            value={newVideoWishDraft}
            onChange={(e) => setNewVideoWishDraft(e.target.value)}
            placeholder={L.video_wishPlaceholder}
          />
          <button
            className="btn btn-accent-soft"
            onClick={() => { actions.saveVideoWishToLibrary(newVideoWishDraft); setNewVideoWishDraft(''); }}
          >
            {L.add}
          </button>
        </div>
      </div>
    </>
  );
}

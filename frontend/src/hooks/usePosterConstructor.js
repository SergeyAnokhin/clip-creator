import { useState } from 'react';
import { api } from '../api/client.js';

const EMPTY_TITLE_CARD = { reference_image_paths: [], variants: [], posters: [] };

/** Owns the Poster constructor's open/closed state and its save/delete/
 * select-main actions - kept separate from useTitleCardStage.js (already
 * sizeable) since posters are a distinct concern: they composite a
 * background image + a title_card variant + an optional logo into a new,
 * re-editable artifact, rather than generating one via an AI model. */
export function usePosterConstructor({ activeProject, setActiveProject, updateProject, showToast, L }) {
  const [constructorOpen, setConstructorOpen] = useState(false);
  const [editingPoster, setEditingPoster] = useState(null);
  const [saving, setSaving] = useState(false);

  const posters = activeProject?.title_card?.posters || [];

  function openConstructor(poster = null) {
    setEditingPoster(poster);
    setConstructorOpen(true);
  }
  function closeConstructor() {
    setConstructorOpen(false);
    setEditingPoster(null);
  }

  async function savePoster({ blob, backgroundPath, titleCardVariantId, logoId, canvasSize, layers, posterId }) {
    if (!activeProject) return;
    setSaving(true);
    try {
      const result = await api.saveTitleCardPoster(activeProject.id, {
        blob, backgroundPath, titleCardVariantId, logoId, canvasSize, layers, posterId,
      });
      setActiveProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), posters: result.posters } }));
      showToast(L.toast_saved);
      closeConstructor();
    } catch (err) {
      console.error('[Poster save] request failed:', err);
      showToast(err?.detail || 'Не удалось сохранить афишу');
    } finally {
      setSaving(false);
    }
  }

  async function deletePoster(posterId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteTitleCardPoster(activeProject.id, posterId);
      setActiveProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), posters: result.posters } }));
    } catch (err) {
      console.error('[Poster delete] request failed:', err);
      showToast('Не удалось удалить афишу');
    }
  }

  function selectMainPoster(posterIdx) {
    updateProject((p) => {
      const current = p.title_card || EMPTY_TITLE_CARD;
      const nextPosters = current.posters.map((ps, i) => ({ ...ps, is_selected: i === posterIdx }));
      return { ...p, title_card: { ...current, posters: nextPosters } };
    });
  }

  return {
    posters, constructorOpen, editingPoster, saving,
    actions: { openConstructor, closeConstructor, savePoster, deletePoster, selectMainPoster },
  };
}

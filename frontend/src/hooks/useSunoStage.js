import { useState } from 'react';
import { api } from '../api/client.js';

/** Suno stage: the skill_prompt (freely editable, no more preset templates),
 * the refinement box, and the generated style/lyrics pair. `skillId` is kept
 * only as a stable label sent to the backend (usage-ledger meta); there's no
 * more UI to change it. */
export function useSunoStage({
  activeProject, setActiveProject, updateProject, showToast, L, textModelDefault, onAiCall, onWishLibraryChange,
}) {
  const [skillId, setSkillId] = useState('skill_a');
  const [refinementText, setRefinementText] = useState('');
  const [sunoLoading, setSunoLoading] = useState(false);
  const [wishLoading, setWishLoading] = useState(false);
  const [trackUrl, setTrackUrl] = useState('');
  // Session-only pick for the "Сгенерировать для Suno" call, seeded from the
  // global default - lets you try another model without going to Settings,
  // without silently changing everyone's default (same pattern the old
  // per-screen wish-model picker used, before that was moved to Settings-only).
  const [genModel, setGenModel] = useState(textModelDefault || '');
  // Raw request/response from the last generateSuno() call, for the debug
  // panel - deliberately not persisted onto the project (would bloat
  // project.json with a full raw API payload on every generation).
  const [lastDebug, setLastDebug] = useState(null);

  function resetForProject(project) {
    setSkillId(project.skill_id || 'skill_a');
    setRefinementText('');
    setTrackUrl(project.track_url || '');
    setGenModel(textModelDefault || '');
    setLastDebug(null);
  }

  function setSkillPrompt(value) {
    updateProject((p) => ({ ...p, skill_prompt: value }), { immediate: false });
  }
  async function addWish() {
    if (!refinementText.trim() || !activeProject) return;
    setWishLoading(true);
    try {
      const result = await api.addSunoWish(activeProject.id, refinementText);
      setActiveProject((p) => ({ ...p, active_wish_ids: result.active_wish_ids }));
      onWishLibraryChange?.(result.suno_wish_library);
      setRefinementText('');
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить пожелание');
    } finally {
      setWishLoading(false);
      onAiCall?.();
    }
  }
  function toggleWish(wishId) {
    updateProject((p) => {
      const active = p.active_wish_ids || [];
      const next = active.includes(wishId) ? active.filter((id) => id !== wishId) : [...active, wishId];
      return { ...p, active_wish_ids: next };
    });
  }
  async function generateSuno() {
    if (!activeProject) return;
    setSunoLoading(true);
    try {
      const result = await api.generateSuno(activeProject.id, {
        skill_id: skillId, skill_prompt: activeProject.skill_prompt, model: genModel,
        active_wish_ids: activeProject.active_wish_ids,
      });
      setActiveProject((p) => ({
        ...p, style: result.style, lyrics: result.lyrics, skill_id: result.skill_id, model_used: result.model_used,
      }));
      setLastDebug(result.debug || null);
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось сгенерировать');
    } finally {
      setSunoLoading(false);
      onAiCall?.();
    }
  }
  function copyStyle() {
    navigator.clipboard?.writeText(activeProject?.style || '').catch(() => {});
    showToast(L.toast_copied);
  }
  function copyLyrics() {
    navigator.clipboard?.writeText(activeProject?.lyrics || '').catch(() => {});
    showToast(L.toast_copied);
  }
  function saveTrackUrl() {
    updateProject((p) => ({ ...p, track_url: trackUrl }));
    showToast(L.toast_saved);
  }

  return {
    state: { skillId, refinementText, sunoLoading, wishLoading, trackUrl, genModel, lastDebug },
    resetForProject,
    actions: {
      setSkillPrompt, setRefinementText, addWish, toggleWish,
      generateSuno, copyStyle, copyLyrics, setTrackUrl, saveTrackUrl, selectGenModel: setGenModel,
    },
  };
}

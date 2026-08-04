import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

/** Suno stage: the skill_prompt (freely editable, no more preset templates),
 * the refinement box, and the generated style/lyrics pair. `skillId` is kept
 * only as a stable label sent to the backend (usage-ledger meta); there's no
 * more UI to change it. */
export function useSunoStage({
  activeProject, setActiveProject, updateProject, showToast, L, textModelDefault, onAiCall, onWishLibraryChange,
  onWishUsed,
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
  // Sticks around (unlike the toast) until the next generateSuno() call, so
  // a timeout/error doesn't just flash past unnoticed - cleared at the start
  // of the next attempt, never by a timer.
  const [sunoError, setSunoError] = useState(null);
  // Ticking "waiting for model" seconds counter, shown next to the loading
  // spinner while generateSuno() is in flight - starts/stops with
  // sunoLoading rather than being managed inside generateSuno() itself, so
  // it can't drift out of sync with the spinner it sits next to.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    if (sunoLoading) {
      setElapsedSeconds(0);
      elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [sunoLoading]);

  function resetForProject(project) {
    setSkillId(project.skill_id || 'skill_a');
    setRefinementText('');
    setTrackUrl(project.track_url || '');
    setGenModel(textModelDefault || '');
    setLastDebug(null);
    setSunoError(null);
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
      const isActivating = !active.includes(wishId);
      const next = isActivating ? [...active, wishId] : active.filter((id) => id !== wishId);
      if (isActivating) onWishUsed?.(wishId);
      return { ...p, active_wish_ids: next };
    });
  }
  async function generateSuno() {
    if (!activeProject) return;
    setSunoLoading(true);
    setSunoError(null);
    try {
      const result = await api.generateSuno(activeProject.id, {
        skill_id: skillId, skill_prompt: activeProject.skill_prompt, model: genModel,
        active_wish_ids: activeProject.active_wish_ids,
      });
      setActiveProject((p) => ({
        ...p, style: result.style, lyrics: result.lyrics, skill_id: result.skill_id, model_used: result.model_used,
      }));
      // completedAt is stamped client-side (not returned by the backend) -
      // it's just "what time did this finish", shown next to the usage
      // summary in the debug panel.
      setLastDebug(result.debug ? { ...result.debug, completedAt: new Date().toISOString() } : null);
      showToast(L.toast_generated);
    } catch (err) {
      const message = err?.detail || 'Не удалось сгенерировать';
      // Surface provider failures/timeouts in devtools too - the toast alone
      // disappears after a few seconds.
      console.error('[Suno generate] request failed:', err);
      setSunoError(message);
      showToast(message);
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
    state: { skillId, refinementText, sunoLoading, wishLoading, trackUrl, genModel, lastDebug, elapsedSeconds, sunoError },
    resetForProject,
    actions: {
      setSkillPrompt, setRefinementText, addWish, toggleWish,
      generateSuno, copyStyle, copyLyrics, setTrackUrl, saveTrackUrl, selectGenModel: setGenModel,
    },
  };
}

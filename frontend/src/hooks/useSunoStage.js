import { useState } from 'react';
import { api } from '../api/client.js';

/** Suno stage: the active skill, its (editable) prompt, the refinement box,
 * and the generated style/lyrics pair. The skill *templates* themselves live
 * in `SKILLS` in components/workflow/SunoStage.jsx. */
export function useSunoStage({
  activeProject, setActiveProject, updateProject, showToast, L, textModelDefault, simpleModelDefault, onAiCall,
}) {
  const [skillId, setSkillId] = useState('skill_a');
  const [refinementText, setRefinementText] = useState('');
  const [sunoLoading, setSunoLoading] = useState(false);
  const [trackUrl, setTrackUrl] = useState('');
  const [wishModel, setWishModel] = useState(simpleModelDefault || '');

  function resetForProject(project) {
    setSkillId(project.skill_id || 'skill_a');
    setRefinementText('');
    setTrackUrl(project.track_url || '');
    setWishModel(simpleModelDefault || '');
  }

  function setSkillPrompt(value) {
    updateProject((p) => ({ ...p, skill_prompt: value }), { immediate: false });
  }
  function selectSkill(id, template) {
    setSkillId(id);
    updateProject((p) => ({ ...p, skill_id: id, skill_prompt: template }));
  }
  async function applyRefinement() {
    if (!refinementText.trim() || !activeProject) return;
    const comment = refinementText;
    try {
      const result = await api.refineSuno(activeProject.id, comment);
      setActiveProject((p) => ({
        ...p, skill_prompt: result.skill_prompt, refinement_comments: result.refinement_comments,
      }));
      setRefinementText('');
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось применить правку');
    }
  }
  async function generateSuno() {
    if (!activeProject) return;
    setSunoLoading(true);
    try {
      const result = await api.generateSuno(activeProject.id, {
        skill_id: skillId, skill_prompt: activeProject.skill_prompt, model: textModelDefault,
      });
      setActiveProject((p) => ({
        ...p, style: result.style, lyrics: result.lyrics, skill_id: result.skill_id, model_used: result.model_used,
      }));
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
    state: { skillId, refinementText, sunoLoading, trackUrl, wishModel },
    resetForProject,
    actions: {
      selectSkill, setSkillPrompt, setRefinementText, applyRefinement,
      generateSuno, copyStyle, copyLyrics, setTrackUrl, saveTrackUrl, selectWishModel: setWishModel,
    },
  };
}

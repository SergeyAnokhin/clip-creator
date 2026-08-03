import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const DEFAULT_SCENE_COUNT = 10;

/** Scenes (text) stage: turns the project's lyrics into `sceneCount` scenes
 * (`{lyric_segment, static_prompt, motion_prompt}`), each editable afterwards.
 * Mirrors useSunoStage.js closely on purpose - same base-prompt/wishes/model/
 * debug-panel pattern, just for scene_mode 'narrative'|'abstract' instead of
 * a single skill prompt (see docs/architecture.md for why the two screens
 * behave alike). Image generation for the resulting scenes lives in
 * useImagesStage.js/ImagesStage.jsx, a separate stage entirely.
 *
 * Storyboard generation replaces project.scenes server-side, so it calls
 * `flushPendingSave()` first - see the autosave race in docs/architecture.md.
 *
 * `generateSceneImage` is a quick single-cheap-preview generator layered on
 * top of the same job-poll infra useImagesStage.js's `generateSceneImages`
 * uses (same backend endpoint, same `scene.images` array) - it always uses
 * `sceneImageModel` (seeded from `image_models_simple.default`, one picker
 * shared across every scene, not per-scene) and a fixed count of 1. The full
 * multi-variant/rating workflow still lives on the Images stage; this is
 * just "let me see roughly what this looks like" without leaving the Scenes
 * stage. */
export function useScenesStage({
  activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, textModels, imageModelsSimple, onAiCall, onSceneWishLibraryChange,
}) {
  const [sceneTextModel, setSceneTextModel] = useState(textModels.default || '');
  const [sceneImageModel, setSceneImageModel] = useState(imageModelsSimple?.default || '');
  const [sceneImageLoadingIdx, setSceneImageLoadingIdx] = useState(null);
  const [sceneMode, setSceneMode] = useState('narrative');
  const [sceneCount, setSceneCount] = useState(DEFAULT_SCENE_COUNT);
  const [styleDescription, setStyleDescription] = useState('');
  const [sceneWishText, setSceneWishText] = useState('');
  const [storyboardLoading, setStoryboardLoading] = useState(false);
  const [wishLoading, setWishLoading] = useState(false);
  const [lastDebug, setLastDebug] = useState(null);
  const [sceneError, setSceneError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    if (storyboardLoading) {
      setElapsedSeconds(0);
      elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [storyboardLoading]);

  function resetForProject(project) {
    setStyleDescription(project.style_description || '');
    setSceneWishText('');
    setSceneMode(project.scene_mode || 'narrative');
    setSceneCount(project.scenes?.length || DEFAULT_SCENE_COUNT);
    setSceneTextModel(textModels.default || '');
    setSceneImageModel(imageModelsSimple?.default || '');
    setLastDebug(null);
    setSceneError(null);
  }

  function onSceneStaticChange(idx, value) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i === idx ? { ...s, static_prompt: value } : s)),
    }), { immediate: false });
  }
  function onSceneMotionChange(idx, value) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i === idx ? { ...s, motion_prompt: value } : s)),
    }), { immediate: false });
  }
  function onStyleDescriptionChange(value) {
    setStyleDescription(value);
    updateProject((p) => ({ ...p, style_description: value }), { immediate: false });
  }

  async function generateStoryboard() {
    if (!activeProject) return;
    setStoryboardLoading(true);
    setSceneError(null);
    try {
      await flushPendingSave();
      const result = await api.generateSceneStoryboard(activeProject.id, {
        style_description: styleDescription, model: sceneTextModel, scene_count: sceneCount,
        scene_mode: sceneMode, active_scene_wish_ids: activeProject.active_scene_wish_ids,
      });
      setActiveProject((p) => ({
        ...p, scenes: result.scenes, style_description: result.style_description, scene_mode: result.scene_mode,
      }));
      setLastDebug(result.debug ? { ...result.debug, completedAt: new Date().toISOString() } : null);
      showToast(L.toast_generated);
    } catch (err) {
      const message = err?.detail || 'Не удалось сгенерировать раскадровку';
      console.error('[Scenes generate] request failed:', err);
      setSceneError(message);
      showToast(message);
    } finally {
      setStoryboardLoading(false);
      onAiCall?.();
    }
  }

  async function addSceneWish() {
    if (!sceneWishText.trim() || !activeProject) return;
    setWishLoading(true);
    try {
      const result = await api.addSceneWish(activeProject.id, sceneWishText);
      setActiveProject((p) => ({ ...p, active_scene_wish_ids: result.active_scene_wish_ids }));
      onSceneWishLibraryChange?.(result.scene_wish_library);
      setSceneWishText('');
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить пожелание');
    } finally {
      setWishLoading(false);
      onAiCall?.();
    }
  }
  function toggleSceneWish(wishId) {
    updateProject((p) => {
      const active = p.active_scene_wish_ids || [];
      const next = active.includes(wishId) ? active.filter((id) => id !== wishId) : [...active, wishId];
      return { ...p, active_scene_wish_ids: next };
    });
  }

  async function pollImageJob(projectId, sceneIdx, jobId) {
    for (;;) {
      const job = await api.getSceneImageJob(projectId, sceneIdx, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  async function generateSceneImage(idx) {
    if (!activeProject) return;
    setSceneImageLoadingIdx(idx);
    try {
      await flushPendingSave();
      const { job_ids: jobIds } = await api.generateSceneImages(
        activeProject.id, idx, { count: 1, model: sceneImageModel },
      );
      const job = await pollImageJob(activeProject.id, idx, jobIds[0]);
      if (job.status === 'completed') {
        setActiveProject((p) => ({
          ...p,
          scenes: p.scenes.map((s, i) => (i === idx ? { ...s, images: [...s.images, job.image] } : s)),
        }));
        showToast(L.toast_generated);
      } else {
        showToast(job.error || 'Не удалось сгенерировать изображение');
      }
    } catch {
      showToast('Не удалось сгенерировать изображение');
    } finally {
      setSceneImageLoadingIdx(null);
      onAiCall?.();
    }
  }

  async function deleteSceneImage(idx, imgIdx) {
    if (!activeProject) return;
    const image = activeProject.scenes[idx]?.images[imgIdx];
    if (!image) return;
    try {
      await api.deleteSceneImage(activeProject.id, idx, image.image_id);
      setActiveProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i !== idx ? s : { ...s, images: s.images.filter((_, j) => j !== imgIdx) })),
      }));
    } catch {
      showToast('Не удалось удалить изображение');
    }
  }

  return {
    state: {
      sceneTextModel, sceneImageModel, sceneImageLoadingIdx, sceneMode, sceneCount, styleDescription, sceneWishText,
      storyboardLoading, wishLoading, lastDebug, sceneError, elapsedSeconds,
    },
    resetForProject,
    actions: {
      selectSceneTextModel: setSceneTextModel, selectSceneImageModel: setSceneImageModel,
      setSceneMode, setSceneCount, setSceneWishText,
      onStyleDescriptionChange, generateStoryboard, addSceneWish, toggleSceneWish,
      onStaticChange: onSceneStaticChange, onMotionChange: onSceneMotionChange,
      onGenerateImage: generateSceneImage, onDeleteImage: deleteSceneImage,
    },
  };
}

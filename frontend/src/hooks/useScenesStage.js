import { useState } from 'react';
import { api } from '../api/client.js';
import { pickMainByRating } from '../lib/scenes.js';

/** Scenes stage: storyboard generation, reference images, per-scene prompt
 * edits, image variants and their ratings.
 *
 * Storyboard and image generation replace project state server-side, so both
 * call `flushPendingSave()` first - see the autosave race in
 * docs/architecture.md. */
export function useScenesStage({
  activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, imageModels, textModels, onAiCall,
}) {
  const [imageModel, setImageModel] = useState(imageModels.default || '');
  const [sceneTextModel, setSceneTextModel] = useState(textModels.default || '');
  const [sceneLoadingIdx, setSceneLoadingIdx] = useState(null);
  const [variantCount, setVariantCount] = useState(1);
  const [styleDescription, setStyleDescription] = useState('');
  const [storyboardLoading, setStoryboardLoading] = useState(false);
  const [referenceUploading, setReferenceUploading] = useState(false);

  function resetForProject(project) {
    setStyleDescription(project.style_description || '');
    setImageModel(imageModels.default || '');
    setSceneTextModel(textModels.default || '');
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
    try {
      await flushPendingSave();
      const result = await api.generateSceneStoryboard(activeProject.id, {
        style_description: styleDescription, model: sceneTextModel,
      });
      setActiveProject((p) => ({ ...p, scenes: result.scenes, style_description: result.style_description }));
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось сгенерировать раскадровку');
    } finally {
      setStoryboardLoading(false);
      onAiCall?.();
    }
  }
  async function uploadReference(file) {
    if (!activeProject || !file) return;
    setReferenceUploading(true);
    try {
      const result = await api.uploadReferenceImage(activeProject.id, file);
      setActiveProject((p) => ({ ...p, reference_images: result.reference_images }));
    } catch {
      showToast('Не удалось загрузить изображение');
    } finally {
      setReferenceUploading(false);
    }
  }
  async function removeReference(path) {
    if (!activeProject) return;
    const filename = path.split('/').pop();
    try {
      const result = await api.deleteReferenceImage(activeProject.id, filename);
      setActiveProject((p) => ({ ...p, reference_images: result.reference_images }));
    } catch {
      showToast('Не удалось удалить изображение');
    }
  }
  async function pollImageJob(projectId, sceneIdx, jobId) {
    for (;;) {
      const job = await api.getSceneImageJob(projectId, sceneIdx, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  async function generateSceneImages(idx) {
    if (!activeProject) return;
    setSceneLoadingIdx(idx);
    try {
      await flushPendingSave();
      const { job_ids: jobIds } = await api.generateSceneImages(activeProject.id, idx, { count: variantCount, model: imageModel });
      const jobs = await Promise.all(jobIds.map((jobId) => pollImageJob(activeProject.id, idx, jobId)));
      const newImages = jobs.filter((j) => j.status === 'completed').map((j) => j.image);
      if (newImages.length) {
        setActiveProject((p) => ({
          ...p,
          scenes: p.scenes.map((s, i) => (i === idx ? { ...s, images: [...s.images, ...newImages] } : s)),
        }));
      }
      const failedJob = jobs.find((j) => j.status === 'failed');
      if (failedJob) {
        showToast(failedJob.error || 'Не удалось сгенерировать часть изображений');
      } else {
        showToast(L.toast_generated);
      }
    } catch {
      showToast('Не удалось сгенерировать изображения');
    } finally {
      setSceneLoadingIdx(null);
      onAiCall?.();
    }
  }
  function rateImage(sceneIdx, imgIdx, rating) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => {
        if (i !== sceneIdx) return s;
        const images = s.images.map((img, j) => (j === imgIdx ? { ...img, rating } : img));
        return { ...s, images: pickMainByRating(images) };
      }),
    }));
  }
  function selectMainImage(sceneIdx, imgIdx) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : {
        ...s,
        images: s.images.map((img, j) => ({ ...img, is_selected: j === imgIdx })),
      })),
    }));
  }

  return {
    state: {
      imageModel, sceneTextModel, variantCount, styleDescription, storyboardLoading, referenceUploading, sceneLoadingIdx,
    },
    resetForProject,
    actions: {
      selectImageModel: setImageModel, selectSceneTextModel: setSceneTextModel, setVariantCount,
      onStyleDescriptionChange, generateStoryboard,
      uploadReference, removeReference,
      onStaticChange: onSceneStaticChange, onMotionChange: onSceneMotionChange,
      onGenerate: generateSceneImages,
      onSelectMain: selectMainImage, onRate: rateImage,
    },
  };
}

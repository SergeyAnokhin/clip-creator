import { useState } from 'react';
import { api } from '../api/client.js';
import { pickMainByRating } from '../lib/scenes.js';

/** Scenes stage: storyboard generation, reference images, per-scene prompt
 * edits, image variants and their ratings.
 *
 * Storyboard and image generation replace project state server-side, so both
 * call `flushPendingSave()` first - see the autosave race in
 * docs/architecture.md. */
export function useScenesStage({ activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L }) {
  const [imageModel, setImageModel] = useState('flux');
  const [sceneLoadingIdx, setSceneLoadingIdx] = useState(null);
  const [variantCount, setVariantCount] = useState(1);
  const [styleDescription, setStyleDescription] = useState('');
  const [storyboardLoading, setStoryboardLoading] = useState(false);
  const [referenceUploading, setReferenceUploading] = useState(false);

  function resetForProject(project) {
    setStyleDescription(project.style_description || '');
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
      const result = await api.generateSceneStoryboard(activeProject.id, { style_description: styleDescription });
      setActiveProject((p) => ({ ...p, scenes: result.scenes, style_description: result.style_description }));
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось сгенерировать раскадровку');
    } finally {
      setStoryboardLoading(false);
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
  async function generateSceneImages(idx) {
    if (!activeProject) return;
    setSceneLoadingIdx(idx);
    try {
      await flushPendingSave();
      const result = await api.generateSceneImages(activeProject.id, idx, { count: variantCount, model: imageModel });
      setActiveProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i === idx ? { ...s, images: result.images } : s)),
      }));
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось сгенерировать изображения');
    } finally {
      setSceneLoadingIdx(null);
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
    state: { imageModel, variantCount, styleDescription, storyboardLoading, referenceUploading, sceneLoadingIdx },
    resetForProject,
    actions: {
      selectImageModel: setImageModel, setVariantCount,
      onStyleDescriptionChange, generateStoryboard,
      uploadReference, removeReference,
      onStaticChange: onSceneStaticChange, onMotionChange: onSceneMotionChange,
      onGenerate: generateSceneImages,
      onSelectMain: selectMainImage, onRate: rateImage,
    },
  };
}

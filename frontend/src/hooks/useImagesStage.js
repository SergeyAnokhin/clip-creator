import { useState } from 'react';
import { api } from '../api/client.js';
import { pickMainByRating } from '../lib/scenes.js';

/** Images stage: turns each scene from the Scenes (text) stage into one or
 * more generated pictures, plus the reference-image/style upload that guides
 * them. Kept separate from useScenesStage.js/ScenesStage.jsx on purpose -
 * scene *text* is one concern (LLM call, editable prompts), scene *images*
 * another (a different provider, its own cheap/quality model tiers, ratings).
 *
 * `imageModelTier` picks which of `imageModels` (quality) / `imageModelsSimple`
 * (cheap) favorites list feeds the model picker - mirrors the text side's
 * text_models/simple_models split, added here because unlike text generation
 * (Suno's genModel vs. simple wish-title model already lived in two separate
 * places) images only ever had one favorites list before.
 *
 * Image generation replaces project state server-side, so it calls
 * `flushPendingSave()` first - see the autosave race in docs/architecture.md. */
export function useImagesStage({
  activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, imageModels, imageModelsSimple, onAiCall,
}) {
  const [imageModelTier, setImageModelTier] = useState('simple');
  const [imageModelMain, setImageModelMain] = useState(imageModels.default || '');
  const [imageModelSimple, setImageModelSimple] = useState(imageModelsSimple.default || '');
  const [sceneLoadingIdx, setSceneLoadingIdx] = useState(null);
  const [variantCount, setVariantCount] = useState(1);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [aspectRatio, setAspectRatio] = useState('auto');

  function resetForProject() {
    setImageModelMain(imageModels.default || '');
    setImageModelSimple(imageModelsSimple.default || '');
    setImageModelTier('simple');
  }

  const imageModel = imageModelTier === 'simple' ? imageModelSimple : imageModelMain;
  function selectImageModel(composite) {
    if (imageModelTier === 'simple') setImageModelSimple(composite);
    else setImageModelMain(composite);
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
      const { job_ids: jobIds } = await api.generateSceneImages(activeProject.id, idx, {
        count: variantCount, model: imageModel, aspect_ratio: aspectRatio === 'auto' ? undefined : aspectRatio,
      });
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
  async function deleteImage(sceneIdx, imgIdx) {
    if (!activeProject) return;
    const image = activeProject.scenes[sceneIdx]?.images[imgIdx];
    if (!image) return;
    try {
      await api.deleteSceneImage(activeProject.id, sceneIdx, image.image_id);
      setActiveProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : { ...s, images: s.images.filter((_, j) => j !== imgIdx) })),
      }));
    } catch {
      showToast('Не удалось удалить изображение');
    }
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

  return {
    state: {
      imageModel, imageModelTier, variantCount, referenceUploading, sceneLoadingIdx, aspectRatio,
    },
    resetForProject,
    actions: {
      setImageModelTier, selectImageModel, setVariantCount, setAspectRatio,
      uploadReference, removeReference,
      onStaticChange: onSceneStaticChange, onMotionChange: onSceneMotionChange,
      onGenerate: generateSceneImages,
      onSelectMain: selectMainImage, onRate: rateImage, onDelete: deleteImage,
    },
  };
}

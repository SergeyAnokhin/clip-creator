import { useState } from 'react';
import { api } from '../api/client.js';
import { pickMainByRating } from '../lib/scenes.js';
import { pickTopReferenceImages } from '../lib/titleCard.js';

const EMPTY_TITLE_CARD = { title_text: '', author_text: '', reference_image_paths: [], variants: [] };
const REFERENCE_SLOTS = 4;

/** Title Card stage: picks up to 4 already-generated (or uploaded) scene
 * images as style references and asks a reference-capable image model
 * (Google Gemini "Nano Banana" / Krea's proxy of it - see
 * providers/title_card.py) to render the given title/author text baked into
 * that style. Kept separate from useImagesStage.js on purpose - different
 * provider call shape (multiple reference images in, not a single text
 * prompt) and project-level persistence (`project.title_card`, not a
 * scene's `images[]`).
 *
 * Mirrors useImagesStage.js's shape: `flushPendingSave()` before generating
 * (image generation replaces project state server-side - see
 * docs/architecture.md), local UI-only state for the model/aspect-ratio
 * pickers, `updateProject` for anything that should persist and survive a
 * reload (text fields, chosen reference paths, variant ratings). */
export function useTitleCardStage({
  activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, imageModels, imageModelsSimple, onAiCall,
}) {
  const [imageModelTier, setImageModelTier] = useState('simple');
  const [imageModelMain, setImageModelMain] = useState(imageModels.default || '');
  const [imageModelSimple, setImageModelSimple] = useState(imageModelsSimple.default || '');
  const [variantCount, setVariantCount] = useState(1);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [generating, setGenerating] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');

  function resetForProject(project) {
    setImageModelMain(imageModels.default || '');
    setImageModelSimple(imageModelsSimple.default || '');
    setImageModelTier('simple');
    setVariantCount(1);
    setAspectRatio('16:9');
    const titleCard = project?.title_card || EMPTY_TITLE_CARD;
    if (!titleCard.reference_image_paths?.length && project?.scenes?.length) {
      const picked = pickTopReferenceImages(project.scenes, REFERENCE_SLOTS);
      if (picked.length) {
        setActiveProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), reference_image_paths: picked } }));
      }
    }
  }

  const imageModel = imageModelTier === 'simple' ? imageModelSimple : imageModelMain;
  function selectImageModel(composite) {
    if (imageModelTier === 'simple') setImageModelSimple(composite);
    else setImageModelMain(composite);
  }

  const titleCard = activeProject?.title_card || EMPTY_TITLE_CARD;
  const referenceSlots = [...titleCard.reference_image_paths, ...Array(REFERENCE_SLOTS).fill(null)].slice(0, REFERENCE_SLOTS);

  function setTitleText(value) {
    updateProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), title_text: value } }), { immediate: false });
  }
  function setAuthorText(value) {
    updateProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), author_text: value } }), { immediate: false });
  }
  function setReferenceSlot(slotIndex, path) {
    updateProject((p) => {
      const current = p.title_card || EMPTY_TITLE_CARD;
      const next = [...current.reference_image_paths];
      next[slotIndex] = path;
      return { ...p, title_card: { ...current, reference_image_paths: next.filter(Boolean) } };
    });
  }
  function removeReferenceSlot(slotIndex) {
    updateProject((p) => {
      const current = p.title_card || EMPTY_TITLE_CARD;
      const next = current.reference_image_paths.filter((_, i) => i !== slotIndex);
      return { ...p, title_card: { ...current, reference_image_paths: next } };
    });
  }
  async function uploadReferenceForSlot(slotIndex, file) {
    if (!activeProject || !file) return;
    try {
      const result = await api.uploadReferenceImage(activeProject.id, file);
      setActiveProject((p) => ({ ...p, reference_images: result.reference_images }));
      setReferenceSlot(slotIndex, result.reference_images[result.reference_images.length - 1]);
    } catch {
      showToast('Не удалось загрузить изображение');
    }
  }

  async function pollJob(projectId, jobId) {
    for (;;) {
      const job = await api.getTitleCardJob(projectId, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  async function generate(basePrompt) {
    if (!activeProject) return;
    const referencePaths = titleCard.reference_image_paths;
    if (!referencePaths.length) {
      showToast(L.titleCard_noReferencesError);
      return;
    }
    setGenerating(true);
    try {
      await flushPendingSave();
      const { job_ids: jobIds } = await api.generateTitleCard(activeProject.id, {
        title_text: titleCard.title_text, author_text: titleCard.author_text, base_prompt: basePrompt,
        reference_image_paths: referencePaths, model: imageModel, aspect_ratio: aspectRatio, count: variantCount,
      });
      const jobs = await Promise.all(jobIds.map((jobId) => pollJob(activeProject.id, jobId)));
      const newVariants = jobs.filter((j) => j.status === 'completed').map((j) => j.variant);
      if (newVariants.length) {
        setActiveProject((p) => ({
          ...p,
          title_card: { ...(p.title_card || EMPTY_TITLE_CARD), variants: [...(p.title_card?.variants || []), ...newVariants] },
        }));
      }
      const failedJob = jobs.find((j) => j.status === 'failed');
      if (failedJob) {
        showToast(failedJob.error || 'Не удалось сгенерировать часть вариантов');
      } else {
        showToast(L.toast_generated);
      }
    } catch {
      showToast('Не удалось сгенерировать афишу');
    } finally {
      setGenerating(false);
      onAiCall?.();
    }
  }

  function rateVariant(variantIdx, rating) {
    updateProject((p) => {
      const current = p.title_card || EMPTY_TITLE_CARD;
      const variants = current.variants.map((v, i) => (i === variantIdx ? { ...v, rating } : v));
      return { ...p, title_card: { ...current, variants: pickMainByRating(variants) } };
    });
  }
  function selectMainVariant(variantIdx) {
    updateProject((p) => {
      const current = p.title_card || EMPTY_TITLE_CARD;
      const variants = current.variants.map((v, i) => ({ ...v, is_selected: i === variantIdx }));
      return { ...p, title_card: { ...current, variants } };
    });
  }
  async function deleteVariant(variantIdx) {
    if (!activeProject) return;
    const variant = titleCard.variants[variantIdx];
    if (!variant) return;
    try {
      await api.deleteTitleCardVariant(activeProject.id, variant.variant_id);
      setActiveProject((p) => ({
        ...p,
        title_card: { ...(p.title_card || EMPTY_TITLE_CARD), variants: p.title_card.variants.filter((_, i) => i !== variantIdx) },
      }));
    } catch {
      showToast('Не удалось удалить вариант');
    }
  }

  return {
    state: {
      imageModel, imageModelTier, variantCount, aspectRatio, generating,
      titleText: titleCard.title_text, authorText: titleCard.author_text,
      referenceSlots, variants: titleCard.variants, presetNameDraft,
    },
    resetForProject,
    actions: {
      setImageModelTier, selectImageModel, setVariantCount, setAspectRatio,
      setTitleText, setAuthorText, setReferenceSlot, removeReferenceSlot, uploadReferenceForSlot,
      onGenerate: generate, onRate: rateVariant, onSelectMain: selectMainVariant, onDelete: deleteVariant,
      setPresetNameDraft,
    },
  };
}

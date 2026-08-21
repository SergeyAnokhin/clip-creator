import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { pickMainByRating } from '../lib/scenes.js';
import { pickTopReferenceImages } from '../lib/titleCard.js';

const EMPTY_TITLE_CARD = { reference_image_paths: [], variants: [] };
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
  onTitleCardWishLibraryChange, onTitleCardWishUsed, beginJob, endJob,
}) {
  const [imageModelTier, setImageModelTier] = useState('simple');
  const [imageModelMain, setImageModelMain] = useState(imageModels.default || '');
  const [imageModelSimple, setImageModelSimple] = useState(imageModelsSimple.default || '');
  const [variantCount, setVariantCount] = useState(1);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [generating, setGenerating] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [titleCardWishText, setTitleCardWishText] = useState('');
  const [wishLoading, setWishLoading] = useState(false);
  const [lastDebug, setLastDebug] = useState(null);
  // variant_ids currently running through "remove background" - several can
  // be in flight independently, each gallery cell shows its own spinner.
  const [removingBgIds, setRemovingBgIds] = useState(() => new Set());
  // Sticks around (unlike the toast) until the next generate() call, so a
  // timeout/error doesn't just flash past unnoticed - mirrors
  // useSunoStage.js's sunoError.
  const [titleCardError, setTitleCardError] = useState(null);
  // Ticking "waiting for model" seconds counter, starts/stops with
  // `generating` rather than being managed inside generate() itself - mirrors
  // useSunoStage.js's elapsedSeconds.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    if (generating) {
      setElapsedSeconds(0);
      elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [generating]);

  function resetForProject(project) {
    setImageModelMain(imageModels.default || '');
    setImageModelSimple(imageModelsSimple.default || '');
    setImageModelTier('simple');
    setVariantCount(1);
    setAspectRatio('16:9');
    setTitleCardWishText('');
    setLastDebug(null);
    setTitleCardError(null);
    const titleCard = project?.title_card || EMPTY_TITLE_CARD;
    if (!titleCard.reference_image_paths?.length && project?.scenes?.length) {
      const picked = pickTopReferenceImages(project.scenes, REFERENCE_SLOTS);
      if (picked.length) {
        setActiveProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), reference_image_paths: picked } }));
      }
    }
    if (titleCard.text_block === undefined) {
      setActiveProject((p) => ({
        ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), text_block: L.titleCard_defaultTextBlock },
      }));
    }
  }

  const imageModel = imageModelTier === 'simple' ? imageModelSimple : imageModelMain;
  function selectImageModel(composite) {
    if (imageModelTier === 'simple') setImageModelSimple(composite);
    else setImageModelMain(composite);
  }

  const titleCard = activeProject?.title_card || EMPTY_TITLE_CARD;
  const referenceSlots = [...titleCard.reference_image_paths, ...Array(REFERENCE_SLOTS).fill(null)].slice(0, REFERENCE_SLOTS);

  function setTextBlock(value) {
    updateProject((p) => ({ ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), text_block: value } }), { immediate: false });
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
      showToast('Не удалось загрузить изображение', 'error');
    }
  }

  async function pollJob(projectId, jobId) {
    for (;;) {
      const job = await api.getTitleCardJob(projectId, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  async function addTitleCardWish() {
    if (!titleCardWishText.trim() || !activeProject) return;
    setWishLoading(true);
    try {
      const result = await api.addTitleCardWish(activeProject.id, titleCardWishText);
      setActiveProject((p) => ({ ...p, active_title_card_wish_ids: result.active_title_card_wish_ids }));
      onTitleCardWishLibraryChange?.(result.title_card_wish_library);
      setTitleCardWishText('');
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить пожелание', 'error');
    } finally {
      setWishLoading(false);
      onAiCall?.();
    }
  }
  function toggleTitleCardWish(wishId) {
    updateProject((p) => {
      const active = p.active_title_card_wish_ids || [];
      const isActivating = !active.includes(wishId);
      const next = isActivating ? [...active, wishId] : active.filter((id) => id !== wishId);
      if (isActivating) onTitleCardWishUsed?.(wishId);
      return { ...p, active_title_card_wish_ids: next };
    });
  }

  async function generate(basePrompt) {
    if (!activeProject) return;
    const referencePaths = titleCard.reference_image_paths;
    if (!referencePaths.length) {
      showToast(L.titleCard_noReferencesError, 'error');
      return;
    }
    // Captured up front: the job outlives the scene/project that is on
    // screen when it finishes, so its result must land where it started.
    const jobProjectId = activeProject.id;
    const registryId = beginJob({ projectId: jobProjectId, stage: 'title_card' });
    setGenerating(true);
    setTitleCardError(null);
    try {
      await flushPendingSave();
      const { job_ids: jobIds } = await api.generateTitleCard(jobProjectId, {
        text_block: titleCard.text_block, base_prompt: basePrompt,
        reference_image_paths: referencePaths, model: imageModel, aspect_ratio: aspectRatio, count: variantCount,
        active_title_card_wish_ids: activeProject.active_title_card_wish_ids,
      });
      const jobs = await Promise.all(jobIds.map((jobId) => pollJob(jobProjectId, jobId)));
      const newVariants = jobs.filter((j) => j.status === 'completed').map((j) => j.variant);
      if (newVariants.length) {
        setActiveProject((p) => (p?.id !== jobProjectId ? p : {
          ...p,
          title_card: { ...(p.title_card || EMPTY_TITLE_CARD), variants: [...(p.title_card?.variants || []), ...newVariants] },
        }));
      }
      const lastJobDebug = jobs[jobs.length - 1]?.debug;
      setLastDebug(lastJobDebug ? { ...lastJobDebug, completedAt: new Date().toISOString() } : null);
      const failedJob = jobs.find((j) => j.status === 'failed');
      if (failedJob) {
        const message = failedJob.error || 'Не удалось сгенерировать часть вариантов';
        setTitleCardError(message);
        showToast(message, 'error');
      } else {
        showToast(L.toast_generated);
      }
    } catch (err) {
      const message = err?.detail || 'Не удалось сгенерировать афишу';
      console.error('[Title Card generate] request failed:', err);
      setTitleCardError(message);
      showToast(message, 'error');
    } finally {
      endJob(registryId);
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
      showToast('Не удалось удалить вариант', 'error');
    }
  }

  async function removeBackground(variantIdx, method) {
    if (!activeProject) return;
    const variant = titleCard.variants[variantIdx];
    if (!variant) return;
    setRemovingBgIds((s) => new Set(s).add(variant.variant_id));
    try {
      const result = await api.removeTitleCardBackground(activeProject.id, variant.variant_id, method);
      setActiveProject((p) => ({
        ...p, title_card: { ...(p.title_card || EMPTY_TITLE_CARD), variants: result.variants },
      }));
      if (result.debug) setLastDebug({ ...result.debug, completedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[Title Card remove background] request failed:', err);
      showToast(err?.detail || 'Не удалось удалить фон', 'error');
    } finally {
      setRemovingBgIds((s) => { const next = new Set(s); next.delete(variant.variant_id); return next; });
      onAiCall?.();
    }
  }

  return {
    state: {
      imageModel, imageModelTier, variantCount, aspectRatio, generating,
      textBlock: titleCard.text_block ?? '',
      referenceSlots, variants: titleCard.variants, presetNameDraft,
      titleCardWishText, wishLoading, lastDebug, elapsedSeconds, titleCardError, removingBgIds,
    },
    resetForProject,
    actions: {
      setImageModelTier, selectImageModel, setVariantCount, setAspectRatio,
      setTextBlock, setReferenceSlot, removeReferenceSlot, uploadReferenceForSlot,
      onGenerate: generate, onRate: rateVariant, onSelectMain: selectMainVariant, onDelete: deleteVariant,
      onRemoveBackground: removeBackground,
      setPresetNameDraft, setTitleCardWishText, addTitleCardWish, toggleTitleCardWish,
    },
  };
}

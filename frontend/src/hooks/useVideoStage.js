import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

export const RESOLUTIONS = ['720p', '1080p'];
export const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16'];

/** Video (animation) stage: the 7th and last step - for the currently-picked
 * scene, sends its `is_selected` image (or an explicit override) plus its
 * `motion_prompt` (already written on the Scenes stage, shared field - see
 * `onMotionChange`) plus any active video wishes to an image-to-video model
 * (`providers/video.py`). Unlike Images/Scenes (a scrollable list of every
 * scene), this stage shows **one scene at a time** with prev/next - the user
 * explicitly asked to "walk scene by scene" rather than scroll a long list,
 * since reviewing/editing an animation per scene is a slower, more deliberate
 * task than picking a picture.
 *
 * Video generation replaces project state server-side, so it calls
 * `flushPendingSave()` first - same autosave race as `useImagesStage.js`. */
export function useVideoStage({
  activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, videoModels, onAiCall,
  onVideoWishLibraryChange, onVideoWishUsed,
}) {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [videoModel, setVideoModel] = useState(videoModels.default || '');
  const [resolution, setResolution] = useState('720p');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [videoWishText, setVideoWishText] = useState('');
  const [wishLoading, setWishLoading] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [lastDebug, setLastDebug] = useState(null);
  const [videoError, setVideoError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    if (videoLoading) {
      setElapsedSeconds(0);
      elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [videoLoading]);

  function resetForProject() {
    setCurrentSceneIndex(0);
    setVideoModel(videoModels.default || '');
    setLastDebug(null);
    setVideoError(null);
  }

  function goToScene(idx) {
    const total = activeProject?.scenes?.length || 0;
    if (idx < 0 || idx >= total) return;
    setCurrentSceneIndex(idx);
    setLastDebug(null);
    setVideoError(null);
  }
  function goPrevScene() { goToScene(currentSceneIndex - 1); }
  function goNextScene() { goToScene(currentSceneIndex + 1); }

  function onMotionChange(value) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i === currentSceneIndex ? { ...s, motion_prompt: value } : s)),
    }), { immediate: false });
  }

  async function addVideoWish() {
    if (!videoWishText.trim() || !activeProject) return;
    setWishLoading(true);
    try {
      const result = await api.addVideoWish(activeProject.id, videoWishText);
      setActiveProject((p) => ({ ...p, active_video_wish_ids: result.active_video_wish_ids }));
      onVideoWishLibraryChange?.(result.video_wish_library);
      setVideoWishText('');
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить пожелание');
    } finally {
      setWishLoading(false);
      onAiCall?.();
    }
  }
  function toggleVideoWish(wishId) {
    updateProject((p) => {
      const active = p.active_video_wish_ids || [];
      const isActivating = !active.includes(wishId);
      const next = isActivating ? [...active, wishId] : active.filter((id) => id !== wishId);
      if (isActivating) onVideoWishUsed?.(wishId);
      return { ...p, active_video_wish_ids: next };
    });
  }

  async function pollVideoJob(projectId, sceneIdx, jobId) {
    for (;;) {
      const job = await api.getSceneVideoJob(projectId, sceneIdx, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async function generateVideo() {
    if (!activeProject) return;
    const scene = activeProject.scenes[currentSceneIndex];
    if (!scene) return;
    if (!(scene.images || []).some((img) => img.is_selected)) {
      showToast('Сначала выберите изображение сцены на этапе «Изображения»');
      return;
    }
    setVideoLoading(true);
    setVideoError(null);
    try {
      await flushPendingSave();
      const { job_ids: jobIds } = await api.generateSceneVideos(activeProject.id, currentSceneIndex, {
        count: 1, model: videoModel, motion_prompt: scene.motion_prompt,
        aspect_ratio: aspectRatio === 'auto' ? undefined : aspectRatio,
        resolution, duration_seconds: durationSeconds,
        active_video_wish_ids: activeProject.active_video_wish_ids,
      });
      const job = await pollVideoJob(activeProject.id, currentSceneIndex, jobIds[0]);
      setLastDebug(job.debug ? { ...job.debug, completedAt: new Date().toISOString() } : null);
      if (job.status === 'completed') {
        setActiveProject((p) => ({
          ...p,
          scenes: p.scenes.map((s, i) => (i === currentSceneIndex ? { ...s, videos: [...(s.videos || []), job.video] } : s)),
        }));
        showToast(L.toast_generated);
      } else {
        setVideoError(job.error || 'Не удалось сгенерировать видео');
        showToast(job.error || 'Не удалось сгенерировать видео');
      }
    } catch (err) {
      const message = err?.detail || 'Не удалось сгенерировать видео';
      console.error('[Video generate] request failed:', err);
      setVideoError(message);
      showToast(message);
    } finally {
      setVideoLoading(false);
      onAiCall?.();
    }
  }

  function rateVideo(sceneIdx, vidIdx, rating) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : {
        ...s, videos: (s.videos || []).map((v, j) => (j === vidIdx ? { ...v, rating } : v)),
      })),
    }));
  }
  function selectMainVideo(sceneIdx, vidIdx) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : {
        ...s, videos: (s.videos || []).map((v, j) => ({ ...v, is_selected: j === vidIdx })),
      })),
    }));
  }
  async function deleteVideo(sceneIdx, vidIdx) {
    if (!activeProject) return;
    const video = activeProject.scenes[sceneIdx]?.videos?.[vidIdx];
    if (!video) return;
    try {
      await api.deleteSceneVideo(activeProject.id, sceneIdx, video.video_id);
      setActiveProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : { ...s, videos: s.videos.filter((_, j) => j !== vidIdx) })),
      }));
    } catch {
      showToast('Не удалось удалить видео');
    }
  }

  return {
    state: {
      currentSceneIndex, videoModel, resolution, aspectRatio, durationSeconds,
      videoWishText, wishLoading, videoLoading, lastDebug, videoError, elapsedSeconds,
    },
    resetForProject,
    actions: {
      goToScene, goPrevScene, goNextScene, selectVideoModel: setVideoModel,
      setResolution, setAspectRatio, setDurationSeconds, setVideoWishText,
      onMotionChange, addVideoWish, toggleVideoWish, generateVideo,
      onRate: rateVideo, onSelectMain: selectMainVideo, onDelete: deleteVideo,
    },
  };
}

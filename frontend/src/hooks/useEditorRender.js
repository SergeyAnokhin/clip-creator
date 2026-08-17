import { useEffect, useState } from 'react';
import { api, mediaUrl } from '../api/client.js';
import { EMPTY_VIDEO_EDIT } from '../lib/editorDefaults.js';

/** The Editor stage's render job: start/poll/delete/download against
 * `providers/editor.py`'s local-ffmpeg render (mirrors useVideoStage.js's
 * generateVideo/pollVideoJob). Split out of `useEditorStage.js` (which
 * composes this alongside `useEditorPreview.js`): none of this touches
 * `video_edit`'s undo/redo history or any clip/overlay/transition mutation,
 * only `activeProject`/`setActiveProject` for the resulting `renders[]`
 * entry - a finished render is server-appended and read back, not built by
 * an edit action here. */
export function useEditorRender({ activeProject, setActiveProject, flushPendingSave, showToast, L }) {
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderError, setRenderError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (renderLoading) {
      setElapsedSeconds(0);
      const timer = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [renderLoading]);

  async function pollRenderJob(projectId, jobId) {
    for (;;) {
      const job = await api.getEditorRenderJob(projectId, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async function startRender(options = {}) {
    if (!activeProject) return;
    setRenderLoading(true);
    setRenderError(null);
    try {
      await flushPendingSave();
      const { job_id: jobId } = await api.startEditorRender(activeProject.id, options.range);
      const job = await pollRenderJob(activeProject.id, jobId);
      if (job.status === 'completed') {
        setActiveProject((p) => ({
          ...p,
          video_edit: { ...(p.video_edit || EMPTY_VIDEO_EDIT), renders: [...(p.video_edit?.renders || []), job.render] },
        }));
        showToast(L.toast_generated);
      } else {
        setRenderError(job.error || 'Не удалось собрать видео');
        showToast(job.error || 'Не удалось собрать видео');
      }
    } catch (err) {
      const message = err?.detail || 'Не удалось собрать видео';
      console.error('[Editor render] request failed:', err);
      setRenderError(message);
      showToast(message);
    } finally {
      setRenderLoading(false);
    }
  }

  async function deleteRender(renderId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteEditorRender(activeProject.id, renderId);
      setActiveProject((p) => ({ ...p, video_edit: { ...(p.video_edit || EMPTY_VIDEO_EDIT), renders: result.renders } }));
    } catch {
      showToast('Не удалось удалить видео');
    }
  }

  function downloadRender(render) {
    if (!activeProject) return;
    const a = document.createElement('a');
    a.href = mediaUrl(`projects/${activeProject.id}/${render.file_path}`);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Called by useEditorStage.js's `resetForProject` on project switch. */
  function resetRender() {
    setRenderError(null);
  }

  return {
    renderLoading, renderError, elapsedSeconds,
    startRender, deleteRender, downloadRender, resetRender,
  };
}

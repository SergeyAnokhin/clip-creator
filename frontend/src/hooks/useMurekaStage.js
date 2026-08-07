import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const EMPTY_MUREKA = { style_input: '', lyrics_input: '', reference_audio: [], tracks: [] };

/** Mureka stage: real audio generation (unlike the Suno stage, which only
 * writes a style/lyrics text pair for pasting elsewhere - see
 * providers/mureka.py). One job per "Сгенерировать" click (Mureka's own `n`
 * parameter returns several tracks from a single task, so this mirrors
 * useTitleCardStage.js's single-job pattern, not useImagesStage.js's
 * one-job-per-variant one), polled at a longer 3s interval since generation
 * takes 30-90s. The "primary" flag is fully manual (`selectMainTrack`), not
 * auto-promoted by rating the way `pickMainByRating` does for scene images -
 * this stage treats star rating and "this is the one I'll use" as separate
 * concepts. */
export function useMurekaStage({
  activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L, onAiCall,
}) {
  const [model, setModel] = useState('auto');
  const [n, setN] = useState(2);
  const [gender, setGender] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [murekaError, setMurekaError] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [uploadingReference, setUploadingReference] = useState(false);
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
    setModel('auto');
    setN(2);
    setGender('');
    setReferenceId('');
    setMurekaError(null);
    const existing = project?.mureka;
    if (!existing || existing.style_input === undefined || existing.lyrics_input === undefined) {
      setActiveProject((p) => ({
        ...p,
        mureka: {
          ...EMPTY_MUREKA,
          ...(p.mureka || {}),
          style_input: existing?.style_input ?? (project?.style || ''),
          lyrics_input: existing?.lyrics_input ?? (project?.lyrics || ''),
        },
      }));
    }
  }

  const mureka = activeProject?.mureka || EMPTY_MUREKA;

  function setStyleInput(value) {
    updateProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), style_input: value } }), { immediate: false });
  }
  function setLyricsInput(value) {
    updateProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), lyrics_input: value } }), { immediate: false });
  }

  async function pollJob(projectId, jobId) {
    for (;;) {
      const job = await api.getMurekaJob(projectId, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async function generate() {
    if (!activeProject) return;
    if (!mureka.lyrics_input?.trim()) {
      showToast(L.mureka_noLyricsError);
      return;
    }
    setGenerating(true);
    setMurekaError(null);
    try {
      await flushPendingSave();
      const { job_id: jobId } = await api.generateMureka(activeProject.id, {
        style: mureka.style_input, lyrics: mureka.lyrics_input,
        model, n, gender: gender || undefined, reference_id: referenceId || undefined,
      });
      const job = await pollJob(activeProject.id, jobId);
      if (job.status === 'completed' && job.tracks?.length) {
        setActiveProject((p) => ({
          ...p,
          mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: [...(p.mureka?.tracks || []), ...job.tracks] },
        }));
        showToast(L.toast_generated);
      } else {
        const message = job.error || L.mureka_generateFailed;
        setMurekaError(message);
        showToast(message);
      }
    } catch (err) {
      const message = err?.detail || L.mureka_generateFailed;
      console.error('[Mureka generate] request failed:', err);
      setMurekaError(message);
      showToast(message);
    } finally {
      setGenerating(false);
      onAiCall?.();
    }
  }

  function rateTrack(trackId, rating) {
    updateProject((p) => {
      const current = p.mureka || EMPTY_MUREKA;
      const tracks = current.tracks.map((t) => (t.track_id === trackId ? { ...t, rating } : t));
      return { ...p, mureka: { ...current, tracks } };
    });
  }
  function selectMainTrack(trackId) {
    updateProject((p) => {
      const current = p.mureka || EMPTY_MUREKA;
      const tracks = current.tracks.map((t) => ({ ...t, is_selected: t.track_id === trackId }));
      return { ...p, mureka: { ...current, tracks } };
    });
  }
  function toggleTrackTag(trackId, tagId) {
    updateProject((p) => {
      const current = p.mureka || EMPTY_MUREKA;
      const tracks = current.tracks.map((t) => {
        if (t.track_id !== trackId) return t;
        const tagIds = t.tag_ids || [];
        const next = tagIds.includes(tagId) ? tagIds.filter((id) => id !== tagId) : [...tagIds, tagId];
        return { ...t, tag_ids: next };
      });
      return { ...p, mureka: { ...current, tracks } };
    });
  }
  async function deleteTrack(trackId) {
    if (!activeProject) return;
    try {
      await api.deleteMurekaTrack(activeProject.id, trackId);
      setActiveProject((p) => ({
        ...p,
        mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: (p.mureka?.tracks || []).filter((t) => t.track_id !== trackId) },
      }));
    } catch {
      showToast(L.mureka_deleteTrackFailed);
    }
  }

  async function uploadReferenceAudio(file) {
    if (!activeProject || !file) return;
    setUploadingReference(true);
    try {
      const result = await api.uploadMurekaReferenceAudio(activeProject.id, file);
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), reference_audio: result.reference_audio } }));
      const last = result.reference_audio[result.reference_audio.length - 1];
      if (last) setReferenceId(last.mureka_file_id);
    } catch (err) {
      showToast(err?.detail || L.mureka_uploadReferenceFailed);
    } finally {
      setUploadingReference(false);
    }
  }
  async function deleteReferenceAudio(refId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteMurekaReferenceAudio(activeProject.id, refId);
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), reference_audio: result.reference_audio } }));
      if (referenceId && !result.reference_audio.some((r) => r.mureka_file_id === referenceId)) setReferenceId('');
    } catch {
      showToast(L.mureka_deleteReferenceFailed);
    }
  }

  return {
    state: {
      styleInput: mureka.style_input ?? '', lyricsInput: mureka.lyrics_input ?? '',
      model, n, gender, referenceId, referenceAudio: mureka.reference_audio, tracks: mureka.tracks,
      generating, elapsedSeconds, murekaError, uploadingReference,
    },
    resetForProject,
    actions: {
      setStyleInput, setLyricsInput, setModel, setN, setGender, setReferenceId,
      onGenerate: generate, onRate: rateTrack, onSelectMain: selectMainTrack, onToggleTag: toggleTrackTag, onDelete: deleteTrack,
      uploadReferenceAudio, deleteReferenceAudio,
    },
  };
}

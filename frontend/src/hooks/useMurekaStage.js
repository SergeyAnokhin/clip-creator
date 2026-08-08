import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const EMPTY_MUREKA = { style_input: '', lyrics_input: '', reference_audio: [], reference_sources: [], tracks: [] };

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
  const [jobStage, setJobStage] = useState(null);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [uploadingReferenceSource, setUploadingReferenceSource] = useState(false);
  const [trimmingReference, setTrimmingReference] = useState(false);
  const [billing, setBilling] = useState(null);
  const [extendingTrackIds, setExtendingTrackIds] = useState([]);
  const [stemmingTrackIds, setStemmingTrackIds] = useState([]);
  const [describingTrackIds, setDescribingTrackIds] = useState([]);
  const [transcribingTrackIds, setTranscribingTrackIds] = useState([]);
  const [lyricsVideoTrackIds, setLyricsVideoTrackIds] = useState([]);
  const elapsedTimerRef = useRef(null);

  useEffect(() => {
    if (generating) {
      setElapsedSeconds(0);
      setJobStage(null);
      elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [generating]);

  function loadBilling() {
    api.getMurekaBilling().then(setBilling).catch(() => setBilling(null));
  }

  function resetForProject(project) {
    setModel('auto');
    setN(2);
    setGender('');
    setReferenceId('');
    setMurekaError(null);
    loadBilling();
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

  /** Polls a job (generate or extend - same {status, tracks, error, stage}
   * shape, see providers/mureka.py's get_job) until terminal, reporting the
   * real intermediate Mureka status (preparing/queued/running/streaming) to
   * the caller on every tick via `onTick` instead of just an elapsed-seconds
   * counter. */
  async function pollJob(projectId, jobId, onTick) {
    for (;;) {
      const job = await api.getMurekaJob(projectId, jobId);
      onTick?.(job);
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
      const job = await pollJob(activeProject.id, jobId, (j) => setJobStage(j.stage || null));
      if (job.status === 'completed' && job.tracks?.length) {
        setActiveProject((p) => ({
          ...p,
          mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: [...(p.mureka?.tracks || []), ...job.tracks] },
        }));
        showToast(L.toast_generated);
        loadBilling();
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

  /** Persists MurekaTrackDetailModal.jsx's manual karaoke sync corrections
   * (`{anchors: {[rowIndex]: userMs}, tempo_marks: [{id, time_ms, direction}]}`,
   * see `lib/lyricsTiming.js`'s `applyManualAnchors`) - debounced like every
   * other frequent-edit field here since a tap can happen many times in a
   * row. `updateSync` is applied functionally (`(prevSync) => nextSync`,
   * `prevSync` always `{anchors: {}, tempo_marks: []}` at minimum) rather
   * than the caller building the full next object itself: two taps fired
   * back-to-back (very much the expected usage - tapping several lines in a
   * row while listening) land in the same React batch, and a caller-built
   * object would close over the same stale pre-tap `track.karaoke_sync` for
   * both, so the second tap's save would silently discard the first. Reading
   * `prevSync` from `p` (the in-flight state `updateProject`'s functional
   * `setActiveProject` update composes across the batch) instead of from
   * whatever the modal last rendered avoids that. */
  function setKaraokeSync(trackId, updateSync) {
    updateProject((p) => {
      const current = p.mureka || EMPTY_MUREKA;
      const tracks = current.tracks.map((t) => {
        if (t.track_id !== trackId) return t;
        const prevSync = t.karaoke_sync || { anchors: {}, tempo_marks: [] };
        const nextSync = typeof updateSync === 'function' ? updateSync(prevSync) : updateSync;
        return { ...t, karaoke_sync: nextSync };
      });
      return { ...p, mureka: { ...current, tracks } };
    }, { immediate: false });
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

  /** Copies a previously generated track's style/lyrics/params back into the
   * current generation form, so "generate again with these settings" doesn't
   * require retyping anything. Pure client-side - the track already carries
   * everything it was generated with (see providers/mureka.py's _run_job). */
  function reuseTrackSettings(track) {
    if (!track) return;
    setStyleInput(track.style || '');
    setLyricsInput(track.lyrics || '');
    if (track.model) setModel(track.model.replace(/^mureka:/, ''));
    const params = track.params || {};
    if (params.n) setN(params.n);
    setGender(params.gender || '');
    setReferenceId(params.reference_id || '');
    showToast(L.mureka_reuseSettingsApplied);
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

  /** ReferenceAudioTrimmer.jsx flow: the raw file is uploaded and kept local
   * first (never sent to Mureka as-is - it may be under Mureka's 30s
   * minimum), then trimmed server-side (ffmpeg) once the user picks a
   * window; only that trimmed clip ever reaches Mureka (trimReferenceSource
   * below), same as uploadReferenceAudio's flow. */
  async function uploadReferenceSource(file) {
    if (!activeProject || !file) return null;
    setUploadingReferenceSource(true);
    try {
      const result = await api.uploadMurekaReferenceSource(activeProject.id, file);
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), reference_sources: result.reference_sources } }));
      return result.reference_sources[result.reference_sources.length - 1] || null;
    } catch (err) {
      showToast(err?.detail || L.mureka_uploadReferenceFailed);
      return null;
    } finally {
      setUploadingReferenceSource(false);
    }
  }
  async function deleteReferenceSource(sourceId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteMurekaReferenceSource(activeProject.id, sourceId);
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), reference_sources: result.reference_sources } }));
    } catch {
      showToast(L.mureka_deleteReferenceFailed);
    }
  }
  async function trimReferenceSource(sourceId, startMs, endMs) {
    if (!activeProject) return false;
    setTrimmingReference(true);
    try {
      const result = await api.trimMurekaReferenceSource(activeProject.id, sourceId, Math.round(startMs), Math.round(endMs));
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), reference_audio: result.reference_audio } }));
      const last = result.reference_audio[result.reference_audio.length - 1];
      if (last) setReferenceId(last.mureka_file_id);
      showToast(L.mureka_trimSuccess);
      return true;
    } catch (err) {
      showToast(err?.detail || L.mureka_trimFailed);
      return false;
    } finally {
      setTrimmingReference(false);
    }
  }

  /** "Продлить" (extend) - real Mureka API call (POST .../extend), same
   * job/poll shape as generate() above. New tracks are appended to the
   * gallery, tagged with extended_from_track_id server-side. */
  async function extendTrack(trackId, { lyrics, extendAt, extendType, model: extendModel } = {}) {
    if (!activeProject) return;
    const trimmed = (lyrics || '').trim();
    if (!trimmed) {
      showToast(L.mureka_extendNoLyricsError);
      return;
    }
    setExtendingTrackIds((ids) => [...ids, trackId]);
    try {
      const { job_id: jobId } = await api.extendMurekaTrack(activeProject.id, trackId, {
        lyrics: trimmed, extend_at: extendAt, extend_type: extendType, model: extendModel,
      });
      const job = await pollJob(activeProject.id, jobId);
      if (job.status === 'completed' && job.tracks?.length) {
        setActiveProject((p) => ({
          ...p,
          mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: [...(p.mureka?.tracks || []), ...job.tracks] },
        }));
        showToast(L.toast_generated);
        loadBilling();
      } else {
        showToast(job.error || L.mureka_extendFailed);
      }
    } catch (err) {
      showToast(err?.detail || L.mureka_extendFailed);
    } finally {
      setExtendingTrackIds((ids) => ids.filter((id) => id !== trackId));
      onAiCall?.();
    }
  }

  /** "Разделить на дорожки" (stem separation) - synchronous Mureka API call
   * (POST .../stem), no job/poll: the response already carries the result,
   * see providers/mureka.py::stem_track. */
  async function stemTrack(trackId, { model: stemModel } = {}) {
    if (!activeProject) return;
    setStemmingTrackIds((ids) => [...ids, trackId]);
    try {
      const result = await api.stemMurekaTrack(activeProject.id, trackId, { model: stemModel });
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: result.tracks } }));
      showToast(L.mureka_stemSuccess);
      loadBilling();
    } catch (err) {
      showToast(err?.detail || L.mureka_stemFailed);
    } finally {
      setStemmingTrackIds((ids) => ids.filter((id) => id !== trackId));
      onAiCall?.();
    }
  }

  /** "Описание песни" (song/describe) - synchronous, real Mureka call, no
   * job/poll (same shape as stemTrack above). Result is appended to the
   * track's own `descriptions[]` server-side; the caller (MurekaStage.jsx)
   * reads the updated track back out of state to show in its own modal. */
  async function describeTrack(trackId) {
    if (!activeProject) return false;
    setDescribingTrackIds((ids) => [...ids, trackId]);
    try {
      const result = await api.describeMurekaTrack(activeProject.id, trackId);
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: result.tracks } }));
      loadBilling();
      return true;
    } catch (err) {
      showToast(err?.detail || L.mureka_describeFailed);
      return false;
    } finally {
      setDescribingTrackIds((ids) => ids.filter((id) => id !== trackId));
      onAiCall?.();
    }
  }

  /** "Ноты из песни" (song/transcribe) - same synchronous shape, appends to
   * `transcriptions[]`. Requires the track's Mureka song_id (raw.id), same
   * constraint as extendTrack. */
  async function transcribeTrack(trackId) {
    if (!activeProject) return false;
    setTranscribingTrackIds((ids) => [...ids, trackId]);
    try {
      const result = await api.transcribeMurekaTrack(activeProject.id, trackId);
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: result.tracks } }));
      loadBilling();
      return true;
    } catch (err) {
      showToast(err?.detail || L.mureka_transcribeFailed);
      return false;
    } finally {
      setTranscribingTrackIds((ids) => ids.filter((id) => id !== trackId));
      onAiCall?.();
    }
  }

  /** "Видео с текстом" (lyrics-video/generate) - same synchronous shape,
   * appends to `lyrics_videos[]`. Also requires the track's Mureka song_id. */
  async function generateLyricsVideo(trackId, { title, aspectRatio } = {}) {
    if (!activeProject) return false;
    setLyricsVideoTrackIds((ids) => [...ids, trackId]);
    try {
      const result = await api.lyricsVideoMurekaTrack(activeProject.id, trackId, {
        title: title || undefined, aspect_ratio: aspectRatio || undefined,
      });
      setActiveProject((p) => ({ ...p, mureka: { ...(p.mureka || EMPTY_MUREKA), tracks: result.tracks } }));
      loadBilling();
      return true;
    } catch (err) {
      showToast(err?.detail || L.mureka_lyricsVideoFailed);
      return false;
    } finally {
      setLyricsVideoTrackIds((ids) => ids.filter((id) => id !== trackId));
      onAiCall?.();
    }
  }

  return {
    state: {
      styleInput: mureka.style_input ?? '', lyricsInput: mureka.lyrics_input ?? '',
      model, n, gender, referenceId, referenceAudio: mureka.reference_audio, referenceSources: mureka.reference_sources,
      tracks: mureka.tracks,
      generating, elapsedSeconds, jobStage, murekaError, uploadingReference, uploadingReferenceSource, trimmingReference,
      billing, extendingTrackIds, stemmingTrackIds, describingTrackIds, transcribingTrackIds, lyricsVideoTrackIds,
    },
    resetForProject,
    actions: {
      setStyleInput, setLyricsInput, setModel, setN, setGender, setReferenceId,
      onGenerate: generate, onRate: rateTrack, onSelectMain: selectMainTrack, onToggleTag: toggleTrackTag, onDelete: deleteTrack,
      onSetKaraokeSync: setKaraokeSync,
      uploadReferenceAudio, deleteReferenceAudio,
      uploadReferenceSource, deleteReferenceSource, trimReferenceSource,
      reuseTrackSettings, extendTrack, stemTrack, describeTrack, transcribeTrack, generateLyricsVideo, loadBilling,
    },
  };
}

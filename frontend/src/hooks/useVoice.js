import { useEffect, useRef, useState } from 'react';

const VOICE_RECORDING_MS = 2400;

/** UI-only speech-to-text simulation, matching the design mock: records for a
 * fixed duration, then splices a canned transcript into the target (a lyrics
 * block, the Suno refinement box, or a scene's static prompt). There is no
 * real STT integration - see docs/architecture.md. */
export function useVoice({ updateProject, showToast, L, setRefinementText }) {
  const [recordingKind, setRecordingKind] = useState(null);
  const [recordingTarget, setRecordingTarget] = useState(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const interval = useRef(null);
  const timeout = useRef(null);

  useEffect(() => () => {
    clearInterval(interval.current);
    clearTimeout(timeout.current);
  }, []);

  function startVoice(kind, target) {
    clearInterval(interval.current);
    clearTimeout(timeout.current);
    setRecordingKind(kind);
    setRecordingTarget(target ?? null);
    setRecordingSeconds(0);
    interval.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    timeout.current = setTimeout(() => stopVoice(kind, target), VOICE_RECORDING_MS);
  }

  function stopVoice(kind, target) {
    clearInterval(interval.current);
    if (kind === 'block') {
      updateProject((p) => ({
        ...p,
        blocks: p.blocks.map((b) => (b.id === target ? { ...b, content: `${b.content}\n[+ голосом: усильте образность строфы]` } : b)),
      }));
    } else if (kind === 'refinement') {
      setRefinementText('Добавь больше джазовых акцентов и сделай упор на саксофонные соло');
    } else if (kind === 'scene') {
      updateProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i === target ? { ...s, static_prompt: `${s.static_prompt}, dramatic fog and neon rim light` } : s)),
      }));
    }
    setRecordingKind(null);
    setRecordingTarget(null);
    showToast(L.toast_voice);
  }

  return { recordingKind, recordingTarget, recordingSeconds, startVoice };
}

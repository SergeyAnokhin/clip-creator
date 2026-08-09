import { useEffect, useRef, useState } from 'react';

const BCP47_BY_LANG = { ru: 'ru-RU', en: 'en-US' };

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export const isVoiceInputSupported = !!getSpeechRecognitionCtor();

/** Real Speech-to-Text via the browser's native Web Speech API (no backend
 * call, no polyfill). Same target model as before - `startVoice(kind, target)`
 * dictates into a lyrics block, the Suno refinement box, or a scene's static
 * prompt - but the transcript now comes from actual recognition instead of a
 * canned string. See docs/architecture.md. */
export function useVoice({ updateProject, showToast, L, lang, setRefinementText, setSceneWishText, setTitleCardWishText, setVideoWishText }) {
  const [recordingKind, setRecordingKind] = useState(null);
  const [recordingTarget, setRecordingTarget] = useState(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recognitionRef = useRef(null);
  const interval = useRef(null);

  useEffect(() => () => {
    clearInterval(interval.current);
    recognitionRef.current?.stop();
  }, []);

  function applyTranscript(kind, target, transcript) {
    if (kind === 'block') {
      updateProject((p) => ({
        ...p,
        blocks: p.blocks.map((b) => (b.id === target ? { ...b, content: `${b.content}\n${transcript}` } : b)),
      }));
    } else if (kind === 'refinement') {
      setRefinementText(transcript);
    } else if (kind === 'sceneWish') {
      setSceneWishText(transcript);
    } else if (kind === 'titleCardWish') {
      setTitleCardWishText(transcript);
    } else if (kind === 'videoWish') {
      setVideoWishText(transcript);
    } else if (kind === 'scene') {
      updateProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i === target ? { ...s, static_prompt: `${s.static_prompt}, ${transcript}` } : s)),
      }));
    }
  }

  function startVoice(kind, target) {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = BCP47_BY_LANG[lang] || 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setRecordingKind(kind);
      setRecordingTarget(target ?? null);
      setRecordingSeconds(0);
      interval.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    };
    recognition.onresult = (event) => {
      applyTranscript(kind, target, event.results[0][0].transcript);
      showToast(L.toast_voice);
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') showToast(L.toast_voice_denied);
      else if (event.error === 'no-speech') showToast(L.toast_voice_no_speech);
      else showToast(L.toast_voice_error);
    };
    recognition.onend = () => {
      clearInterval(interval.current);
      recognitionRef.current = null;
      setRecordingKind(null);
      setRecordingTarget(null);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  return { recordingKind, recordingTarget, recordingSeconds, startVoice, isSupported: isVoiceInputSupported };
}

/** Lighter-weight dictation for a single standalone text field (no
 * `project`/`refinement` scope needed) - e.g. the Settings wish-library
 * add/edit inputs. `fieldId` just identifies which field is "recording" for
 * UI purposes; the caller decides how to merge the transcript into its own
 * state via `onTranscript`. */
export function useFieldVoice({ showToast, L, lang }) {
  const [recordingField, setRecordingField] = useState(null);
  const recognitionRef = useRef(null);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  function startFieldVoice(fieldId, onTranscript) {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) return;

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = BCP47_BY_LANG[lang] || 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setRecordingField(fieldId);
    recognition.onresult = (event) => {
      onTranscript(event.results[0][0].transcript);
      showToast(L.toast_voice);
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') showToast(L.toast_voice_denied);
      else if (event.error === 'no-speech') showToast(L.toast_voice_no_speech);
      else showToast(L.toast_voice_error);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setRecordingField(null);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  return { recordingField, startFieldVoice, isSupported: isVoiceInputSupported };
}

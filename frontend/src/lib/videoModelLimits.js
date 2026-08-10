/** Known duration/resolution/aspect-ratio limits for the video (image-to-
 * video) models offered in VideoStage.jsx's ModelPicker, sourced from each
 * provider's own docs (OpenRouter's per-model pages + Google's Veo docs,
 * checked 2026-08-10) since the app itself doesn't fetch or enforce them -
 * it just sends whatever the user picked in the resolution/aspect-
 * ratio/duration controls and lets the provider accept or reject it.
 * `test` matches against the model id half of the "{provider}:{model_id}"
 * composite ModelPicker uses; order matters, most specific pattern first
 * (e.g. "veo-3.1-lite" before the generic "veo-3.1"). */
export const VIDEO_MODEL_LIMITS = [
  {
    test: (id) => /veo-3\.1-lite/i.test(id),
    duration: '4–8', resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    noteKey: 'video_limitNote_veoLite',
  },
  {
    test: (id) => /veo-3\.1/i.test(id),
    duration: '4, 6, 8', resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'],
    noteKey: 'video_limitNote_veo31',
  },
  {
    test: (id) => /seedance-2\.5/i.test(id),
    duration: '4–30', resolutions: ['480p', '720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'],
    noteKey: 'video_limitNote_seedance25',
  },
  {
    test: (id) => /seedance-2\.0-fast/i.test(id),
    duration: '4–15', resolutions: ['480p', '720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    noteKey: 'video_limitNote_seedance20fast',
  },
  {
    test: (id) => /seedance-2\.0/i.test(id),
    duration: '4–15', resolutions: ['480p', '720p', '1080p', '2K'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    noteKey: 'video_limitNote_seedance20',
  },
  {
    test: (id) => /flux-3-video/i.test(id),
    duration: '5–20', resolutions: ['hd (~720p)', 'fhd (~1080p)'],
    aspectRatios: ['21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16'],
    noteKey: 'video_limitNote_flux3',
  },
  {
    test: (id) => /grok-imagine-video-1\.5/i.test(id),
    duration: '1–15', resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    noteKey: 'video_limitNote_grokImagine',
  },
];

/** `composite` is the ModelPicker "{provider}:{model_id}" value; only the
 * model_id half is matched against, provider prefix is ignored. */
export function getVideoModelLimits(composite) {
  const modelId = (composite || '').split(':').slice(1).join(':');
  return VIDEO_MODEL_LIMITS.find((entry) => entry.test(modelId)) || null;
}

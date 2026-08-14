// Which providers each model-favorites panel offers. Shared by
// SettingsScreen.jsx (its "refresh models" calls) and ModelsTab.jsx.

export const MODEL_PROVIDERS = [
  { id: 'google', name: 'Google (Gemini)' },
  { id: 'google_free', name: 'Google (Gemini) Free' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'replicate', name: 'Replicate' },
  { id: 'fal', name: 'FAL' },
];

// Krea (krea.ai) is image/video-only - it has no text/LLM models, so it's
// only offered for the image-model favorites panel, not text/simple ones.
export const IMAGE_MODEL_PROVIDERS = [...MODEL_PROVIDERS, { id: 'krea', name: 'Krea AI' }];

// Only Google (Veo) and OpenRouter do image-to-video generation for this app
// - see providers/video.py's module docstring.
export const VIDEO_MODEL_PROVIDERS = [
  { id: 'google', name: 'Google (Gemini)' },
  { id: 'google_free', name: 'Google (Gemini) Free' },
  { id: 'openrouter', name: 'OpenRouter' },
];

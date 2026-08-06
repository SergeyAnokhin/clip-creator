const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8020';

async function request(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${options?.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    // FastAPI's HTTPException body is `{"detail": "..."}` - surface that
    // human-readable message separately so callers (e.g. the Suno generate
    // flow's timeout error) can show it directly instead of this raw string.
    try {
      err.detail = JSON.parse(body)?.detail;
    } catch {
      // body wasn't JSON - err.detail stays undefined, caller falls back.
    }
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function requestForm(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${options?.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;

/** Builds a query string from a params object, dropping empty/undefined
 * values so callers can pass optional filters unconditionally. */
function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

export const mediaUrl = (path) => `${BASE_URL}/media/${path}`;

export const api = {
  listProjects: () => request('/api/projects'),
  createProject: (url, rawText) => request('/api/projects', { method: 'POST', body: JSON.stringify({ url, raw_text: rawText }) }),
  getProject: (id) => request(projectPath(id)),
  patchProject: (id, patch) => request(projectPath(id), { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id) => request(projectPath(id), { method: 'DELETE' }),

  getSettings: () => request('/api/settings'),
  putSettings: (settings) => request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  listModels: (provider) => request(`/api/settings/models/${encodeURIComponent(provider)}`),
  listImageModels: (provider) => request(`/api/settings/image-models/${encodeURIComponent(provider)}`),
  getModelsCatalog: () => request('/api/settings/models-catalog'),
  getSunoPromptPresets: () => request('/api/settings/suno-prompt-presets'),
  saveWishToLibrary: (text) => request('/api/settings/wish-library', { method: 'POST', body: JSON.stringify({ text }) }),
  updateWishSnippet: (id, patch) => request(`/api/settings/wish-library/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  saveSceneWishToLibrary: (text) => request('/api/settings/scene-wish-library', { method: 'POST', body: JSON.stringify({ text }) }),
  updateSceneWishSnippet: (id, patch) => request(`/api/settings/scene-wish-library/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  generateSuno: (id, body) => request(`${projectPath(id)}/suno/generate`, { method: 'POST', body: JSON.stringify(body || {}) }),
  addSunoWish: (id, text) => request(`${projectPath(id)}/suno/wishes`, { method: 'POST', body: JSON.stringify({ text }) }),

  generateSceneStoryboard: (id, body) => request(`${projectPath(id)}/scenes/generate`, { method: 'POST', body: JSON.stringify(body || {}) }),
  addSceneWish: (id, text) => request(`${projectPath(id)}/scenes/wishes`, { method: 'POST', body: JSON.stringify({ text }) }),
  generateSceneImages: (id, sceneIndex, body) => request(`${projectPath(id)}/scenes/${sceneIndex}/images`, { method: 'POST', body: JSON.stringify(body || {}) }),
  getSceneImageJob: (id, sceneIndex, jobId) => request(`${projectPath(id)}/scenes/${sceneIndex}/images/jobs/${encodeURIComponent(jobId)}`),
  deleteSceneImage: (id, sceneIndex, imageId) => request(`${projectPath(id)}/scenes/${sceneIndex}/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' }),
  uploadSceneImageFile: (id, sceneIndex, file) => {
    const form = new FormData();
    form.append('file', file);
    return requestForm(`${projectPath(id)}/scenes/${sceneIndex}/images/upload`, { method: 'POST', body: form });
  },
  uploadSceneImageUrl: (id, sceneIndex, url) => {
    const form = new FormData();
    form.append('url', url);
    return requestForm(`${projectPath(id)}/scenes/${sceneIndex}/images/upload`, { method: 'POST', body: form });
  },

  listUsage: (params) => request(`/api/usage/records${qs(params)}`),
  usageSummary: (params) => request(`/api/usage/summary${qs(params)}`),
  usageToday: (tzOffset) => request(`/api/usage/today${qs({ tz_offset: tzOffset })}`),
  usagePeriodTotals: (tzOffset) => request(`/api/usage/period-totals${qs({ tz_offset: tzOffset })}`),
  getPricing: () => request('/api/usage/pricing'),
  putPricingOverrides: (overrides) => request('/api/usage/pricing', { method: 'PUT', body: JSON.stringify({ pricing_overrides: overrides }) }),

  translateText: (text, targetLang) => request('/api/translate', { method: 'POST', body: JSON.stringify({ text, target_lang: targetLang }) }),

  uploadReferenceImage: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    return requestForm(`${projectPath(id)}/reference-images`, { method: 'POST', body: form });
  },
  deleteReferenceImage: (id, filename) => request(`${projectPath(id)}/reference-images/${encodeURIComponent(filename)}`, { method: 'DELETE' }),

  generateTitleCard: (id, body) => request(`${projectPath(id)}/title-card/generate`, { method: 'POST', body: JSON.stringify(body || {}) }),
  addTitleCardWish: (id, text) => request(`${projectPath(id)}/title-card/wishes`, { method: 'POST', body: JSON.stringify({ text }) }),
  getTitleCardJob: (id, jobId) => request(`${projectPath(id)}/title-card/jobs/${encodeURIComponent(jobId)}`),
  deleteTitleCardVariant: (id, variantId) => request(`${projectPath(id)}/title-card/variants/${encodeURIComponent(variantId)}`, { method: 'DELETE' }),
  removeTitleCardBackground: (id, variantId) => request(`${projectPath(id)}/title-card/variants/${encodeURIComponent(variantId)}/remove-background`, { method: 'POST' }),

  uploadLogo: (name, file) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name || '');
    return requestForm('/api/settings/logos', { method: 'POST', body: form });
  },
  deleteLogo: (logoId) => request(`/api/settings/logos/${encodeURIComponent(logoId)}`, { method: 'DELETE' }),

  saveTitleCardPoster: (id, { blob, backgroundPath, titleCardVariantId, logoId, canvasSize, layers, posterId }) => {
    const form = new FormData();
    form.append('file', blob, 'poster.png');
    form.append('background_path', backgroundPath);
    form.append('title_card_variant_id', titleCardVariantId);
    form.append('logo_id', logoId || '');
    form.append('canvas_size', JSON.stringify(canvasSize));
    form.append('layers', JSON.stringify(layers));
    form.append('poster_id', posterId || '');
    return requestForm(`${projectPath(id)}/title-card/poster`, { method: 'POST', body: form });
  },
  deleteTitleCardPoster: (id, posterId) => request(`${projectPath(id)}/title-card/poster/${encodeURIComponent(posterId)}`, { method: 'DELETE' }),
};

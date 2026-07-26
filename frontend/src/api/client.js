const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

async function request(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${options?.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

const projectPath = (id) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  listProjects: () => request('/api/projects'),
  createProject: (url, rawText) => request('/api/projects', { method: 'POST', body: JSON.stringify({ url, raw_text: rawText }) }),
  getProject: (id) => request(projectPath(id)),
  patchProject: (id, patch) => request(projectPath(id), { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id) => request(projectPath(id), { method: 'DELETE' }),

  getSettings: () => request('/api/settings'),
  putSettings: (settings) => request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  generateSuno: (id) => request(`${projectPath(id)}/suno/generate`, { method: 'POST' }),
  generateSceneImages: (id, sceneIndex) => request(`${projectPath(id)}/scenes/${sceneIndex}/images`, { method: 'POST' }),
};

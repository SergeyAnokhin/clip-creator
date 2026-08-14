import { useState } from 'react';
import { api } from '../api/client.js';

/** "Magic layers" — the inverse of the poster constructor: one flat image is
 * decomposed by Qwen-Image-Layered (see providers/magic_layers.py) into N
 * RGBA layers that already carry painted content behind whatever covered
 * them, so any of them can be moved without leaving a hole.
 *
 * Groups live at project level (`project.magic_layer_groups`), not on the
 * scene image or title-card variant they came from — one decomposition is
 * reusable by every poster. All three entry points (Images stage, Title Card
 * gallery, Poster constructor) go through this one hook and address a group
 * by its `source_path`.
 *
 * Decomposition takes 15–30s, so the backend hands back a job id and this
 * polls it at the same 1.5s cadence as useTitleCardStage.js's pollJob. */
export function useMagicLayers({ activeProject, setActiveProject, flushPendingSave, showToast, L, onAiCall }) {
  // source_paths currently being decomposed — several can run at once, each
  // image shows its own spinner (mirrors useTitleCardStage's removingBgIds).
  const [busySources, setBusySources] = useState(() => new Set());

  const groups = activeProject?.magic_layer_groups || [];

  function groupsForSource(sourcePath) {
    return groups.filter((g) => g.source_path === sourcePath);
  }

  async function pollJob(projectId, jobId) {
    for (;;) {
      const job = await api.getMagicLayersJob(projectId, jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /** `sourcePath` is a project-relative media path (a scene image's or a
   * title-card variant's `file_path`). Returns the new group, or null. */
  async function decompose(sourcePath, { method, numLayers, sourceKind } = {}) {
    if (!activeProject || !sourcePath) return null;
    if (busySources.has(sourcePath)) return null;
    setBusySources((s) => new Set(s).add(sourcePath));
    try {
      // The job writes the group onto the project server-side, so any pending
      // local save has to land first or it would overwrite the new group.
      await flushPendingSave?.();
      const { job_id: jobId } = await api.startMagicLayers(activeProject.id, {
        source_path: sourcePath, source_kind: sourceKind, method, num_layers: numLayers,
      });
      const job = await pollJob(activeProject.id, jobId);
      if (job.status !== 'completed') {
        showToast(job.error || L.magic_error);
        return null;
      }
      setActiveProject((p) => ({ ...p, magic_layer_groups: [...(p.magic_layer_groups || []), job.group] }));
      showToast(L.magic_done);
      return job.group;
    } catch (err) {
      console.error('[Magic layers] request failed:', err);
      showToast(err?.detail || L.magic_error);
      return null;
    } finally {
      setBusySources((s) => { const next = new Set(s); next.delete(sourcePath); return next; });
      onAiCall?.();
    }
  }

  async function deleteGroup(groupId) {
    if (!activeProject) return;
    try {
      const result = await api.deleteMagicLayerGroup(activeProject.id, groupId);
      setActiveProject((p) => ({ ...p, magic_layer_groups: result.magic_layer_groups }));
    } catch (err) {
      console.error('[Magic layers delete] request failed:', err);
      showToast(err?.detail || L.magic_deleteError);
    }
  }

  return {
    state: { groups, busySources },
    actions: { decompose, deleteGroup, groupsForSource },
  };
}

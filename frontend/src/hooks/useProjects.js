import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { debounce } from '../lib/debounce.js';

/** The project list, the "New Workflow" modal, and the currently open project.
 *
 * Also owns persistence for every stage: `updateProject` applies a patch
 * function to the open project locally, then PATCHes the whole object back -
 * immediately, or through a 400ms debounce for text-field edits. */
export function useProjects({ showToast, L }) {
  const [projects, setProjects] = useState([]);
  const [homeFilter, setHomeFilter] = useState('all');
  const [homeSearch, setHomeSearch] = useState('');
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [modalUrl, setModalUrl] = useState('');
  const [modalRawText, setModalRawText] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [activeProject, setActiveProject] = useState(null);

  async function refreshProjects() {
    try {
      setProjects(await api.listProjects());
    } catch {
      showToast('Не удалось загрузить проекты');
    }
  }

  useEffect(() => { refreshProjects(); }, []);

  const debouncedPatch = useMemo(
    () => debounce((id, project) => {
      api.patchProject(id, project).catch(() => showToast('Не удалось сохранить'));
    }, 400),
    [],
  );

  function updateProject(patchFn, { immediate = true } = {}) {
    setActiveProject((prev) => {
      if (!prev) return prev;
      const next = patchFn(prev);
      if (immediate) {
        api.patchProject(next.id, next).catch(() => showToast('Не удалось сохранить'));
      } else {
        debouncedPatch(next.id, next);
      }
      return next;
    });
  }

  /** Cancels any in-flight debounced autosave and synchronously persists the
   * current project first. Without this, a debounced edit (e.g. typing the
   * style description) can land *after* a server-side action that replaces
   * `scenes` wholesale (storyboard generation, image generation) and silently
   * revert it to a stale snapshot - call this right before such actions. */
  async function flushPendingSave() {
    debouncedPatch.cancel();
    if (activeProject) {
      try {
        await api.patchProject(activeProject.id, activeProject);
      } catch {
        showToast('Не удалось сохранить');
      }
    }
  }

  function openNewProjectModal() { setShowNewProjectModal(true); setModalUrl(''); setModalRawText(''); }
  function closeNewProjectModal() { setShowNewProjectModal(false); }

  async function submitNewProject() {
    setModalLoading(true);
    try {
      await api.createProject(modalUrl, modalRawText);
      await refreshProjects();
      setShowNewProjectModal(false);
      showToast(L.toast_created);
    } catch {
      showToast('Не удалось создать проект');
    } finally {
      setModalLoading(false);
    }
  }

  async function deleteProject(id) {
    try {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      showToast(L.toast_deletedProject);
    } catch {
      showToast('Не удалось удалить проект');
    }
  }

  /** Loads a project into `activeProject` and returns it, so the caller can
   * seed the per-stage hooks from it. Returns null (and toasts) on failure. */
  async function loadProject(id) {
    try {
      const project = await api.getProject(id);
      setActiveProject(project);
      return project;
    } catch {
      showToast('Не удалось открыть проект');
      return null;
    }
  }

  function closeProject() { setActiveProject(null); }

  return {
    projects, homeFilter, homeSearch,
    showNewProjectModal, modalUrl, modalRawText, modalLoading,
    activeProject, setActiveProject,
    updateProject, flushPendingSave,
    refreshProjects, loadProject, closeProject,
    homeActions: {
      setHomeFilter, setHomeSearch,
      openNewProjectModal, closeNewProjectModal,
      setModalUrl, setModalRawText, submitNewProject,
      deleteProject,
    },
  };
}

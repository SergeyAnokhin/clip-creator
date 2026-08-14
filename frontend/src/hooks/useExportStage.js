import { api } from '../api/client.js';

/** Export stage - the final step: bundles the project's finished
 * deliverables (every generated video candidate across every scene, the
 * selected Mureka track, and whichever Title Card variants are marked for
 * export) into one zip via `GET .../final-export`
 * (`export_final_package` in `routers/generation_export.py`). No AI calls or
 * per-project session state here - just a download trigger plus the one new
 * per-variant toggle (`marked_for_export`, independent of `is_selected`
 * since the Title Card stage's single "main" pick stays single while export
 * wants to allow several at once). */
export function useExportStage({ activeProject, updateProject }) {
  function toggleTitleCardExport(variantIdx) {
    updateProject((p) => {
      const current = p.title_card || { variants: [] };
      const variants = current.variants.map((v, i) => (
        i === variantIdx ? { ...v, marked_for_export: !v.marked_for_export } : v
      ));
      return { ...p, title_card: { ...current, variants } };
    });
  }

  function downloadExport() {
    if (!activeProject) return;
    const url = api.finalExportUrl(activeProject.id);
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return {
    state: {},
    actions: { toggleTitleCardExport, downloadExport },
  };
}

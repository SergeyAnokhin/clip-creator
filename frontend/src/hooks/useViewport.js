import { useEffect, useState } from 'react';

/** Responsive breakpoint plus the workflow sidebar, which follows it: the
 * sidebar collapses when crossing into mobile and opens again above it. */
export function useViewport() {
  const [viewport, setViewport] = useState('desktop');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    function onResize() {
      const w = window.innerWidth;
      const vp = w < 760 ? 'mobile' : w < 1180 ? 'tablet' : 'desktop';
      setViewport((prev) => {
        if (prev === vp) return prev;
        setSidebarOpen(vp !== 'mobile');
        return vp;
      });
    }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return {
    viewport,
    sidebarOpen,
    toggleSidebar: () => setSidebarOpen((s) => !s),
    closeSidebarMobile: () => setSidebarOpen(false),
    /** Called when opening a project, so the sidebar starts in the state the
     * current viewport expects. */
    resetSidebar: () => setSidebarOpen(viewport !== 'mobile'),
  };
}

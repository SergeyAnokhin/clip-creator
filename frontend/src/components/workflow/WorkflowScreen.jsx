import WorkflowHeader from './WorkflowHeader.jsx';
import Sidebar from './Sidebar.jsx';
import LyricsStage from './LyricsStage.jsx';
import SunoStage from './SunoStage.jsx';
import ScenesStage from './ScenesStage.jsx';

export default function WorkflowScreen({
  L, langLabel, viewport, project, activeStage, sidebarOpen,
  lyricsState, sunoState, scenesState, updateProject,
  onGoHome, onToggleSidebar, onCloseSidebarMobile, onToggleLang, onOpenSettings, onSelectStage,
  usageToday, usagePeriodTotals, onOpenUsage, onLoadUsagePeriodTotals,
}) {
  const isMobile = viewport === 'mobile';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <WorkflowHeader
        L={L}
        langLabel={langLabel}
        title={project.title}
        author={project.author}
        onGoHome={onGoHome}
        onToggleSidebar={onToggleSidebar}
        onToggleLang={onToggleLang}
        onOpenSettings={onOpenSettings}
        onChangeTitle={(title) => updateProject((p) => ({ ...p, title }), { immediate: false })}
        onChangeAuthor={(author) => updateProject((p) => ({ ...p, author }), { immediate: false })}
        usageToday={usageToday} usagePeriodTotals={usagePeriodTotals} onOpenUsage={onOpenUsage}
        onLoadUsagePeriodTotals={onLoadUsagePeriodTotals}
      />

      <div className="workflow-body">
        <Sidebar
          L={L}
          project={project}
          activeStage={activeStage}
          viewport={viewport}
          sidebarOpen={sidebarOpen}
          onSelectStage={onSelectStage}
          onCloseMobile={onCloseSidebarMobile}
        />

        <div className="workflow-main" style={{ padding: isMobile ? '18px 14px' : '28px 32px' }}>
          <div className="workflow-main-inner">
            {activeStage === 'lyrics' && <LyricsStage L={L} project={project} viewport={viewport} {...lyricsState} />}
            {activeStage === 'suno' && <SunoStage L={L} project={project} isMobile={isMobile} {...sunoState} />}
            {activeStage === 'scenes' && <ScenesStage L={L} project={project} isMobile={isMobile} {...scenesState} />}
          </div>
        </div>
      </div>
    </div>
  );
}

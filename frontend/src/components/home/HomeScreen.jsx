import { Search } from 'lucide-react';
import Header from './Header.jsx';
import FilterChips from './FilterChips.jsx';
import ProjectGrid from './ProjectGrid.jsx';
import EmptyState from './EmptyState.jsx';
import NewProjectModal from './NewProjectModal.jsx';

export default function HomeScreen({
  L, lang, langLabel, viewport,
  projects, homeFilter, homeSearch,
  showNewProjectModal, modalUrl, modalRawText, modalLoading,
  onToggleLang, onOpenSettings, onOpenNewProjectModal, onCloseNewProjectModal,
  onModalUrlChange, onModalRawTextChange, onSubmitNewProject,
  onFilterChange, onSearchChange, onOpenProject, onDeleteProject,
  usageToday, usagePeriodTotals, onOpenUsage, onLoadUsagePeriodTotals,
  miniPlayerTrack, miniPlayerIsPlaying, onToggleMiniPlayer,
}) {
  const isMobile = viewport === 'mobile';
  const isTablet = viewport === 'tablet';

  const visible = projects.filter((p) => {
    const matchesFilter = homeFilter === 'all'
      || (homeFilter === 'suno' && p.suno_done)
      || (homeFilter === 'scenes' && p.scenes_ready === p.scenes_total);
    const q = homeSearch.trim().toLowerCase();
    const matchesSearch = !q || p.title.toLowerCase().includes(q) || p.author.toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Header
        L={L} langLabel={langLabel} onToggleLang={onToggleLang} onOpenSettings={onOpenSettings}
        onNewWorkflow={onOpenNewProjectModal} usageToday={usageToday} usagePeriodTotals={usagePeriodTotals}
        onOpenUsage={onOpenUsage} onLoadUsagePeriodTotals={onLoadUsagePeriodTotals}
        miniPlayerTrack={miniPlayerTrack} miniPlayerIsPlaying={miniPlayerIsPlaying} onToggleMiniPlayer={onToggleMiniPlayer}
      />

      <div className="home-main" style={{ padding: isMobile ? '20px 16px' : '36px 32px' }}>
        <div className="home-hero-glow" />
        <div className="home-main-inner">
          <h1 className="home-title" style={{ fontSize: isMobile ? 26 : isTablet ? 32 : 38 }}>{L.hubTitle}</h1>
          <p className="home-subtitle">{L.hubSubtitle}</p>

          <div className="home-toolbar">
            <div className="search-box">
              <Search size={15} />
              <input
                value={homeSearch}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={L.searchPlaceholder}
              />
            </div>
            <FilterChips L={L} value={homeFilter} onChange={onFilterChange} />
          </div>

          {visible.length > 0 ? (
            <ProjectGrid
              projects={visible}
              L={L}
              lang={lang}
              columns={isMobile ? '1fr' : isTablet ? 'repeat(2,1fr)' : 'repeat(3,1fr)'}
              onOpen={onOpenProject}
              onDelete={onDeleteProject}
            />
          ) : (
            <EmptyState L={L} onNewWorkflow={onOpenNewProjectModal} />
          )}
        </div>
      </div>

      {showNewProjectModal && (
        <NewProjectModal
          L={L}
          url={modalUrl}
          rawText={modalRawText}
          loading={modalLoading}
          onUrlChange={onModalUrlChange}
          onRawTextChange={onModalRawTextChange}
          onSubmit={onSubmitNewProject}
          onClose={onCloseNewProjectModal}
        />
      )}
    </div>
  );
}

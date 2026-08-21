import { CheckCircle2, Circle, Clapperboard, CircleSlash, Download, Film, Image as ImageIcon, Loader, ListMusic, Music2, Music4, Scissors, Type } from 'lucide-react';
import { onActivateKey } from '../../lib/a11y.js';
import { stageProgress } from '../../lib/stageStatus.js';

const STATUS_ICON = { blocked: CircleSlash, pending: Circle, processing: Loader, running: Loader, completed: CheckCircle2 };
const STATUS_COLOR = {
  blocked: 'rgba(255,255,255,0.16)',
  pending: 'rgba(255,255,255,0.25)',
  processing: '#fbbf24',
  running: '#fbbf24',
  completed: '#4ade80',
};

/** Stage rows used to carry three or four non-interactive "sub" captions each
 * ("Импорт", "Разбивка", ...). They read as a second level of navigation,
 * nothing happened when clicked, and 18 of them roughly doubled the sidebar's
 * height - pushing Export and Editor below the fold. They are replaced by the
 * per-stage counter that `stageProgress` already computes. */
function stageDefs(L) {
  return [
    { key: 'lyrics', name: L.stage_lyrics, icon: ListMusic },
    { key: 'suno', name: L.stage_suno, icon: Music2 },
    { key: 'mureka', name: L.stage_mureka, icon: Music4 },
    { key: 'scenes', name: L.stage_scenes, icon: Clapperboard },
    { key: 'images', name: L.stage_images, icon: ImageIcon },
    { key: 'title_card', name: L.stage_titleCard, icon: Type },
    { key: 'video', name: L.stage_video, icon: Film },
    { key: 'export', name: L.stage_export, icon: Download },
    { key: 'editor', name: L.stage_editor, icon: Scissors },
  ];
}

export default function Sidebar({ L, project, activeStage, viewport, sidebarOpen, jobs, onSelectStage, onCloseMobile }) {
  const isMobile = viewport === 'mobile';
  const isTablet = viewport === 'tablet';
  const runningStages = new Set((jobs || []).map((j) => j.stage));

  const style = isMobile
    ? {
        position: 'fixed', top: 64, left: 0, bottom: 0, width: 250,
        background: 'rgba(18,16,14,0.98)', backdropFilter: 'blur(20px)', zIndex: 25,
        transform: `translateX(${sidebarOpen ? '0' : '-100%'})`, transition: 'transform 0.25s ease',
        display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(255,255,255,0.08)',
      }
    : {
        position: 'relative', width: sidebarOpen ? (isTablet ? 220 : 250) : 0, overflow: 'hidden',
        transition: 'width 0.22s ease', flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: 'rgba(255,255,255,0.03)', borderRight: '1px solid rgba(255,255,255,0.08)',
      };

  function selectStage(key) {
    onSelectStage(key);
    // On mobile the drawer covers the content it just navigated to, so it has
    // to close itself - the backdrop tap used to be the only way out.
    if (isMobile) onCloseMobile?.();
  }

  return (
    <>
      {/* Tap-outside-to-close is a pointer convenience next to the header's
          own menu toggle, so the backdrop stays presentational. */}
      {isMobile && sidebarOpen && <div className="sidebar-backdrop" role="presentation" onClick={onCloseMobile} />}
      <div className="sidebar" style={style}>
        <div className="sidebar-inner">
          {stageDefs(L).map((stage, index) => {
            const { status: dataStatus, counter } = stageProgress(stage.key, project);
            const status = runningStages.has(stage.key) ? 'running' : dataStatus;
            const StatusIcon = STATUS_ICON[status];
            const isActive = activeStage === stage.key;
            const StageIcon = stage.icon;
            return (
              <div key={stage.key} style={{ marginBottom: 2 }}>
                <div
                  className="stage-row"
                  style={{
                    background: isActive ? 'rgba(255,157,92,0.12)' : 'transparent',
                    borderColor: isActive ? 'rgba(255,157,92,0.3)' : 'transparent',
                    opacity: status === 'blocked' && !isActive ? 0.55 : 1,
                  }}
                  role="button" tabIndex={0} aria-current={isActive ? 'step' : undefined}
                  title={`${index + 1}. ${stage.name} — ${L['stageStatus_' + status]}`}
                  onClick={() => selectStage(stage.key)}
                  onKeyDown={onActivateKey(() => selectStage(stage.key))}
                >
                  <span
                    className="stage-icon"
                    style={{
                      color: isActive ? '#ff9d5c' : 'rgba(255,255,255,0.6)',
                      background: isActive ? 'rgba(255,157,92,0.16)' : 'rgba(255,255,255,0.06)',
                    }}
                  >
                    <StageIcon size={13} />
                  </span>
                  <span className="stage-name">{stage.name}</span>
                  {counter && <span className="stage-counter">{counter}</span>}
                  <StatusIcon
                    size={13}
                    color={STATUS_COLOR[status]}
                    className={status === 'running' ? 'stage-status-running' : undefined}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

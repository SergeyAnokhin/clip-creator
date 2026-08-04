import { CheckCircle2, Circle, Clapperboard, Image as ImageIcon, Loader, ListMusic, Minus, Music2, Type } from 'lucide-react';

const STATUS_ICON = { pending: Circle, processing: Loader, completed: CheckCircle2 };
const STATUS_COLOR = { pending: 'rgba(255,255,255,0.25)', processing: '#fbbf24', completed: '#4ade80' };

function stageDefs(L) {
  return [
    { key: 'lyrics', name: L.stage_lyrics, icon: ListMusic, sub: [L.sub_import, L.sub_split, L.sub_tags] },
    { key: 'suno', name: L.stage_suno, icon: Music2, sub: [L.sub_skill, L.sub_gen, L.sub_final] },
    { key: 'scenes', name: L.stage_scenes, icon: Clapperboard, sub: [L.sub_script, L.sub_wishes] },
    { key: 'images', name: L.stage_images, icon: ImageIcon, sub: [L.sub_images, L.sub_rating] },
    { key: 'title_card', name: L.stage_titleCard, icon: Type, sub: [L.sub_titleCardText, L.sub_titleCardStyle] },
  ];
}

function stageStatus(key, project) {
  if (key === 'lyrics') return 'completed';
  if (key === 'suno') return project.style ? 'completed' : project.blocks.length > 0 ? 'processing' : 'pending';
  if (key === 'scenes') return project.scenes.length > 0 ? 'completed' : 'pending';
  if (key === 'title_card') return (project.title_card?.variants?.length ?? 0) > 0 ? 'completed' : 'pending';
  const total = project.scenes.length;
  const ready = project.scenes.filter((s) => s.images && s.images.length > 0).length;
  if (total === 0) return 'pending';
  return ready === total ? 'completed' : ready > 0 ? 'processing' : 'pending';
}

export default function Sidebar({ L, project, activeStage, viewport, sidebarOpen, onSelectStage, onCloseMobile }) {
  const isMobile = viewport === 'mobile';
  const isTablet = viewport === 'tablet';

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

  return (
    <>
      {isMobile && sidebarOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <div className="sidebar" style={style}>
        <div className="sidebar-inner">
          {stageDefs(L).map((stage) => {
            const status = stageStatus(stage.key, project);
            const StatusIcon = STATUS_ICON[status];
            const isActive = activeStage === stage.key;
            const StageIcon = stage.icon;
            return (
              <div key={stage.key} style={{ marginBottom: 4 }}>
                <div
                  className="stage-row"
                  style={{
                    background: isActive ? 'rgba(255,157,92,0.12)' : 'transparent',
                    borderColor: isActive ? 'rgba(255,157,92,0.3)' : 'transparent',
                  }}
                  onClick={() => onSelectStage(stage.key)}
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
                  <StatusIcon size={13} color={STATUS_COLOR[status]} />
                </div>
                {stage.sub.map((name) => (
                  <div key={name} className="stage-sub">
                    <Minus size={11} color="rgba(255,255,255,0.3)" />
                    {name}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

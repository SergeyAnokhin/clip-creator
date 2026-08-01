import { useState } from 'react';
import { useToast } from './hooks/useToast.js';
import { useViewport } from './hooks/useViewport.js';
import { useUsage } from './hooks/useUsage.js';
import { useSettings } from './hooks/useSettings.js';
import { useProjects } from './hooks/useProjects.js';
import { useLyricsStage } from './hooks/useLyricsStage.js';
import { useSunoStage } from './hooks/useSunoStage.js';
import { useScenesStage } from './hooks/useScenesStage.js';
import { useVoice } from './hooks/useVoice.js';
import HomeScreen from './components/home/HomeScreen.jsx';
import WorkflowScreen from './components/workflow/WorkflowScreen.jsx';
import SettingsScreen from './components/settings/SettingsScreen.jsx';
import UsageScreen from './components/usage/UsageScreen.jsx';
import Toast from './components/Toast.jsx';
import './styles/theme.css';

/**
 * Composition root: owns only navigation (which screen / which stage), wires
 * the hooks together in dependency order, and assembles the per-stage prop
 * bundles. All domain state and actions live in `src/hooks/`.
 */
function App() {
  const [screen, setScreen] = useState('home');
  const [prevScreen, setPrevScreen] = useState('home');
  const [usageReturnScreen, setUsageReturnScreen] = useState('home');
  const [activeStage, setActiveStage] = useState('lyrics');

  const { toast, showToast } = useToast();
  const view = useViewport();
  const usage = useUsage();
  const settings = useSettings({ showToast, onAiCall: usage.actions.refreshToday });
  const L = settings.L;

  const projects = useProjects({ showToast, L });
  const { activeProject, setActiveProject, updateProject, flushPendingSave } = projects;

  const lyrics = useLyricsStage({ updateProject, showToast, L });
  const suno = useSunoStage({
    activeProject, setActiveProject, updateProject, showToast, L,
    textModelDefault: settings.textModels.default,
    simpleModelDefault: settings.simpleModels.default,
    onAiCall: usage.actions.refreshToday,
  });
  const scenes = useScenesStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    imageModels: settings.imageModels, textModels: settings.textModels,
    onAiCall: usage.actions.refreshToday,
  });
  // Depends on suno's refinement box, so it must be created after it.
  const voice = useVoice({ updateProject, showToast, L, lang: settings.lang, setRefinementText: suno.actions.setRefinementText });

  // ---------- navigation ----------
  async function openProject(id) {
    const project = await projects.loadProject(id);
    if (!project) return;
    setActiveStage('lyrics');
    view.resetSidebar();
    suno.resetForProject(project);
    scenes.resetForProject(project);
    setScreen('workflow');
  }

  function goHome() {
    setScreen('home');
    projects.closeProject();
    projects.refreshProjects();
  }

  function openSettings() { setPrevScreen(screen); setScreen('settings'); }
  function closeSettings() { setScreen(prevScreen); }
  // Separate from prevScreen: the pill lives in the Settings header too, so
  // settings -> usage -> back must return to settings, not overwrite the
  // screen Settings itself uses to get home.
  function openUsage() { setUsageReturnScreen(screen); setScreen('usage'); }
  function closeUsage() { setScreen(usageReturnScreen); }

  // ---------- per-stage prop bundles ----------
  const lyricsState = {
    ...lyrics.state,
    specialTags: settings.specialTags,
    recordingBlockId: voice.recordingKind === 'block' ? voice.recordingTarget : null,
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    actions: { ...lyrics.actions, startVoice: voice.startVoice },
  };

  const sunoState = {
    ...suno.state,
    isRecordingRefinement: voice.recordingKind === 'refinement',
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    wishLibrary: settings.wishLibrary,
    simpleModelFavorites: settings.simpleModels.favorites,
    modelPrices: usage.priceMap,
    actions: {
      ...suno.actions, startVoice: voice.startVoice,
      saveWishToLibrary: (text) => settings.actions.saveWishToLibrary(text, suno.state.wishModel),
    },
  };

  const scenesState = {
    ...scenes.state,
    sceneRecordingIdx: voice.recordingKind === 'scene' ? voice.recordingTarget : null,
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    imageModelFavorites: settings.imageModels.favorites,
    textModelFavorites: settings.textModels.favorites,
    modelPrices: usage.priceMap,
    actions: { ...scenes.actions, onVoiceEdit: (idx) => voice.startVoice('scene', idx) },
  };

  return (
    <div className="app-shell">
      {screen === 'home' && (
        <HomeScreen
          L={L} lang={settings.lang} langLabel={settings.langLabel} viewport={view.viewport}
          projects={projects.projects} homeFilter={projects.homeFilter} homeSearch={projects.homeSearch}
          showNewProjectModal={projects.showNewProjectModal} modalUrl={projects.modalUrl}
          modalRawText={projects.modalRawText} modalLoading={projects.modalLoading}
          onToggleLang={settings.toggleLang} onOpenSettings={openSettings}
          onOpenNewProjectModal={projects.homeActions.openNewProjectModal}
          onCloseNewProjectModal={projects.homeActions.closeNewProjectModal}
          onModalUrlChange={projects.homeActions.setModalUrl}
          onModalRawTextChange={projects.homeActions.setModalRawText}
          onSubmitNewProject={projects.homeActions.submitNewProject}
          onFilterChange={projects.homeActions.setHomeFilter} onSearchChange={projects.homeActions.setHomeSearch}
          onOpenProject={openProject} onDeleteProject={projects.homeActions.deleteProject}
          usageToday={usage.today} onOpenUsage={openUsage}
        />
      )}

      {screen === 'workflow' && activeProject && (
        <WorkflowScreen
          L={L} langLabel={settings.langLabel} viewport={view.viewport}
          project={activeProject} activeStage={activeStage} sidebarOpen={view.sidebarOpen}
          lyricsState={lyricsState} sunoState={sunoState} scenesState={scenesState} updateProject={updateProject}
          onGoHome={goHome} onToggleSidebar={view.toggleSidebar} onCloseSidebarMobile={view.closeSidebarMobile}
          onToggleLang={settings.toggleLang} onOpenSettings={openSettings} onSelectStage={setActiveStage}
          usageToday={usage.today} onOpenUsage={openUsage}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          L={L} lang={settings.lang} showToast={showToast} apiKeys={settings.apiKeys}
          textModels={settings.textModels} simpleModels={settings.simpleModels}
          imageModels={settings.imageModels}
          specialTags={settings.specialTags}
          sunoBasePrompt={settings.sunoBasePrompt}
          referenceExamples={settings.referenceExamples} wishLibrary={settings.wishLibrary}
          pricing={usage.pricing} usageToday={usage.today}
          onClose={closeSettings} onOpenUsage={openUsage}
          actions={{ ...settings.actions, savePricingOverrides: usage.actions.savePricingOverrides, refreshPricing: usage.actions.refreshPricing }}
        />
      )}

      {screen === 'usage' && (
        <UsageScreen L={L} usage={usage} onClose={closeUsage} />
      )}

      <Toast message={toast} />
    </div>
  );
}

export default App;

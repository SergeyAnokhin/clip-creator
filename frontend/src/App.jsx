import { useState } from 'react';
import { useToast } from './hooks/useToast.js';
import { useViewport } from './hooks/useViewport.js';
import { useUsage } from './hooks/useUsage.js';
import { useSettings } from './hooks/useSettings.js';
import { useProjects } from './hooks/useProjects.js';
import { useLyricsStage } from './hooks/useLyricsStage.js';
import { useSunoStage } from './hooks/useSunoStage.js';
import { useScenesStage } from './hooks/useScenesStage.js';
import { useImagesStage } from './hooks/useImagesStage.js';
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
    onAiCall: usage.actions.refreshToday,
    onWishLibraryChange: settings.actions.setWishLibrary,
  });
  const scenes = useScenesStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    textModels: settings.textModels, imageModelsSimple: settings.imageModelsSimple,
    onAiCall: usage.actions.refreshToday,
    onSceneWishLibraryChange: settings.actions.setSceneWishLibrary,
  });
  const images = useImagesStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    imageModels: settings.imageModels, imageModelsSimple: settings.imageModelsSimple,
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
    images.resetForProject(project);
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
    simpleModelDefault: settings.simpleModels.default,
    simpleModelFavorites: settings.simpleModels.favorites,
    textModelFavorites: settings.textModels.favorites,
    modelPrices: usage.priceMap,
    sunoBasePrompt: settings.sunoBasePrompt,
    sunoPromptPresets: settings.sunoPromptPresets,
    referenceExamples: settings.referenceExamples,
    actions: {
      ...suno.actions, startVoice: voice.startVoice,
      updateSunoBasePrompt: settings.actions.updateSunoBasePrompt,
    },
  };

  const scenesState = {
    ...scenes.state,
    sceneRecordingIdx: voice.recordingKind === 'scene' ? voice.recordingTarget : null,
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    textModelFavorites: settings.textModels.favorites,
    modelPrices: usage.priceMap,
    sceneWishLibrary: settings.sceneWishLibrary,
    sceneBasePromptNarrative: settings.sceneBasePromptNarrative,
    sceneBasePromptAbstract: settings.sceneBasePromptAbstract,
    sceneImageModelFavorites: settings.imageModelsSimple.favorites,
    hideMotionPrompt: settings.hideMotionPrompt,
    actions: {
      ...scenes.actions, onVoiceEdit: (idx) => voice.startVoice('scene', idx),
      updateSceneBasePromptNarrative: settings.actions.updateSceneBasePromptNarrative,
      updateSceneBasePromptAbstract: settings.actions.updateSceneBasePromptAbstract,
      setHideMotionPrompt: settings.actions.setHideMotionPrompt,
    },
  };

  const imagesState = {
    ...images.state,
    sceneRecordingIdx: voice.recordingKind === 'scene' ? voice.recordingTarget : null,
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    imageModelFavorites: settings.imageModels.favorites,
    imageModelSimpleFavorites: settings.imageModelsSimple.favorites,
    modelPrices: usage.priceMap,
    hideMotionPrompt: settings.hideMotionPrompt,
    actions: {
      ...images.actions, onVoiceEdit: (idx) => voice.startVoice('scene', idx),
      setHideMotionPrompt: settings.actions.setHideMotionPrompt,
    },
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
          usageToday={usage.today} usagePeriodTotals={usage.periodTotals} onOpenUsage={openUsage}
          onLoadUsagePeriodTotals={usage.actions.loadPeriodTotals}
        />
      )}

      {screen === 'workflow' && activeProject && (
        <WorkflowScreen
          L={L} langLabel={settings.langLabel} viewport={view.viewport}
          project={activeProject} activeStage={activeStage} sidebarOpen={view.sidebarOpen}
          lyricsState={lyricsState} sunoState={sunoState} scenesState={scenesState} imagesState={imagesState} updateProject={updateProject}
          onGoHome={goHome} onToggleSidebar={view.toggleSidebar} onCloseSidebarMobile={view.closeSidebarMobile}
          onToggleLang={settings.toggleLang} onOpenSettings={openSettings} onSelectStage={setActiveStage}
          usageToday={usage.today} usagePeriodTotals={usage.periodTotals} onOpenUsage={openUsage}
          onLoadUsagePeriodTotals={usage.actions.loadPeriodTotals}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          L={L} lang={settings.lang} showToast={showToast} apiKeys={settings.apiKeys}
          textModels={settings.textModels} simpleModels={settings.simpleModels}
          imageModels={settings.imageModels} imageModelsSimple={settings.imageModelsSimple}
          specialTags={settings.specialTags}
          sunoBasePrompt={settings.sunoBasePrompt} sunoPromptPresets={settings.sunoPromptPresets}
          referenceExamples={settings.referenceExamples} wishLibrary={settings.wishLibrary}
          requestTimeoutSeconds={settings.requestTimeoutSeconds}
          sceneBasePromptNarrative={settings.sceneBasePromptNarrative} sceneBasePromptAbstract={settings.sceneBasePromptAbstract}
          sceneWishLibrary={settings.sceneWishLibrary}
          pricing={usage.pricing} usageToday={usage.today} usagePeriodTotals={usage.periodTotals}
          onLoadUsagePeriodTotals={usage.actions.loadPeriodTotals}
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

import { useState } from 'react';
import { useToast } from './hooks/useToast.js';
import { useViewport } from './hooks/useViewport.js';
import { useUsage } from './hooks/useUsage.js';
import { useSettings } from './hooks/useSettings.js';
import { useProjects } from './hooks/useProjects.js';
import { useLyricsStage } from './hooks/useLyricsStage.js';
import { useSunoStage } from './hooks/useSunoStage.js';
import { useMurekaStage } from './hooks/useMurekaStage.js';
import { useScenesStage } from './hooks/useScenesStage.js';
import { useImagesStage } from './hooks/useImagesStage.js';
import { useTitleCardStage } from './hooks/useTitleCardStage.js';
import { useVideoStage } from './hooks/useVideoStage.js';
import { useExportStage } from './hooks/useExportStage.js';
import { useEditorStage } from './hooks/useEditorStage.js';
import { usePosterConstructor } from './hooks/usePosterConstructor.js';
import { useVoice } from './hooks/useVoice.js';
import { useMiniPlayer } from './hooks/useMiniPlayer.js';
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
  const miniPlayer = useMiniPlayer();
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
    onWishUsed: settings.actions.bumpWishUse,
  });
  const mureka = useMurekaStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    onAiCall: usage.actions.refreshToday,
  });
  const scenes = useScenesStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    textModels: settings.textModels, imageModelsSimple: settings.imageModelsSimple,
    onAiCall: usage.actions.refreshToday,
    onSceneWishLibraryChange: settings.actions.setSceneWishLibrary,
    onSceneWishUsed: settings.actions.bumpSceneWishUse,
  });
  const images = useImagesStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    imageModels: settings.imageModels, imageModelsSimple: settings.imageModelsSimple,
    onAiCall: usage.actions.refreshToday,
  });
  const titleCard = useTitleCardStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    imageModels: settings.imageModels, imageModelsSimple: settings.imageModelsSimple,
    onAiCall: usage.actions.refreshToday,
    onTitleCardWishLibraryChange: settings.actions.setTitleCardWishLibrary,
    onTitleCardWishUsed: settings.actions.bumpTitleCardWishUse,
  });
  const posterConstructor = usePosterConstructor({
    activeProject, setActiveProject, updateProject, showToast, L,
  });
  const video = useVideoStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
    videoModels: settings.videoModels,
    onAiCall: usage.actions.refreshToday,
    onVideoWishLibraryChange: settings.actions.setVideoWishLibrary,
    onVideoWishUsed: settings.actions.bumpVideoWishUse,
  });
  const exportStage = useExportStage({ activeProject, updateProject });
  const editorStage = useEditorStage({
    activeProject, setActiveProject, updateProject, flushPendingSave, showToast, L,
  });
  // Depends on suno's refinement box, scenes' wish box, title card's wish box and video's wish box, so it must be created after them.
  const voice = useVoice({
    updateProject, showToast, L, lang: settings.lang,
    setRefinementText: suno.actions.setRefinementText, setSceneWishText: scenes.actions.setSceneWishText,
    setTitleCardWishText: titleCard.actions.setTitleCardWishText, setVideoWishText: video.actions.setVideoWishText,
  });

  // ---------- navigation ----------
  async function openProject(id) {
    const project = await projects.loadProject(id);
    if (!project) return;
    setActiveStage('lyrics');
    view.resetSidebar();
    suno.resetForProject(project);
    mureka.resetForProject(project);
    scenes.resetForProject(project);
    images.resetForProject(project);
    titleCard.resetForProject(project);
    video.resetForProject(project);
    editorStage.resetForProject(project);
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
      onDeleteWish: settings.actions.removeWishSnippet,
    },
  };

  const murekaState = {
    ...mureka.state,
    musicTags: settings.musicTags,
    miniPlayerTrack: miniPlayer.state.track,
    miniPlayerIsPlaying: miniPlayer.state.isPlaying,
    miniPlayerCurrentTimeMs: miniPlayer.state.currentTimeMs,
    actions: {
      ...mureka.actions, onOpenSettings: openSettings,
      onPlayTrack: miniPlayer.actions.playTrack, onToggleTrack: miniPlayer.actions.toggle,
      onSeekTrack: miniPlayer.actions.seek,
    },
  };

  const scenesState = {
    ...scenes.state,
    sceneRecordingIdx: voice.recordingKind === 'scene' ? voice.recordingTarget : null,
    isRecordingSceneWish: voice.recordingKind === 'sceneWish',
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
      startVoice: voice.startVoice,
      updateSceneBasePromptNarrative: settings.actions.updateSceneBasePromptNarrative,
      updateSceneBasePromptAbstract: settings.actions.updateSceneBasePromptAbstract,
      setHideMotionPrompt: settings.actions.setHideMotionPrompt,
      onDeleteSceneWish: settings.actions.removeSceneWishSnippet,
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
    outpaintQualityMode: settings.outpaintQualityMode,
    actions: {
      ...images.actions, onVoiceEdit: (idx) => voice.startVoice('scene', idx),
      setHideMotionPrompt: settings.actions.setHideMotionPrompt,
    },
  };

  const titleCardState = {
    ...titleCard.state,
    imageModelFavorites: settings.imageModels.favorites,
    imageModelSimpleFavorites: settings.imageModelsSimple.favorites,
    modelPrices: usage.priceMap,
    titleCardBasePrompt: settings.titleCardBasePrompt,
    titleCardBasePromptPresets: settings.titleCardBasePromptPresets,
    titleCardWishLibrary: settings.titleCardWishLibrary,
    isRecordingTitleCardWish: voice.recordingKind === 'titleCardWish',
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    posters: posterConstructor.posters, posterConstructorOpen: posterConstructor.constructorOpen,
    editingPoster: posterConstructor.editingPoster, posterSaving: posterConstructor.saving,
    logos: settings.logos, posterTemplates: settings.posterTemplates,
    actions: {
      ...titleCard.actions,
      ...posterConstructor.actions,
      updateTitleCardBasePrompt: settings.actions.updateTitleCardBasePrompt,
      saveTitleCardBasePromptPreset: settings.actions.saveTitleCardBasePromptPreset,
      loadTitleCardBasePromptPreset: settings.actions.loadTitleCardBasePromptPreset,
      deleteTitleCardBasePromptPreset: settings.actions.deleteTitleCardBasePromptPreset,
      onDeleteTitleCardWish: settings.actions.removeTitleCardWishSnippet,
      savePosterTemplate: settings.actions.savePosterTemplate,
      deletePosterTemplate: settings.actions.deletePosterTemplate,
      startVoice: voice.startVoice,
    },
  };

  const videoState = {
    ...video.state,
    videoModelFavorites: settings.videoModels.favorites,
    modelPrices: usage.priceMap,
    videoWishLibrary: settings.videoWishLibrary,
    isRecordingVideoWish: voice.recordingKind === 'videoWish',
    recordingSeconds: voice.recordingSeconds,
    voiceSupported: voice.isSupported,
    actions: {
      ...video.actions, startVoice: voice.startVoice,
      onDeleteVideoWish: settings.actions.removeVideoWishSnippet,
    },
  };

  const exportState = {
    ...exportStage.state,
    actions: { ...exportStage.actions },
  };

  const editorState = {
    ...editorStage.state,
    actions: { ...editorStage.actions },
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
          miniPlayerTrack={miniPlayer.state.track} miniPlayerIsPlaying={miniPlayer.state.isPlaying}
          onToggleMiniPlayer={miniPlayer.actions.toggle}
        />
      )}

      {screen === 'workflow' && activeProject && (
        <WorkflowScreen
          L={L} langLabel={settings.langLabel} viewport={view.viewport}
          project={activeProject} activeStage={activeStage} sidebarOpen={view.sidebarOpen}
          lyricsState={lyricsState} sunoState={sunoState} murekaState={murekaState} scenesState={scenesState} imagesState={imagesState}
          titleCardState={titleCardState} videoState={videoState} exportState={exportState} editorState={editorState} updateProject={updateProject}
          onGoHome={goHome} onToggleSidebar={view.toggleSidebar} onCloseSidebarMobile={view.closeSidebarMobile}
          onToggleLang={settings.toggleLang} onOpenSettings={openSettings} onSelectStage={setActiveStage}
          usageToday={usage.today} usagePeriodTotals={usage.periodTotals} onOpenUsage={openUsage}
          onLoadUsagePeriodTotals={usage.actions.loadPeriodTotals}
          miniPlayerTrack={miniPlayer.state.track} miniPlayerIsPlaying={miniPlayer.state.isPlaying}
          onToggleMiniPlayer={miniPlayer.actions.toggle}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          L={L} lang={settings.lang} showToast={showToast} apiKeys={settings.apiKeys}
          textModels={settings.textModels} simpleModels={settings.simpleModels}
          imageModels={settings.imageModels} imageModelsSimple={settings.imageModelsSimple}
          videoModels={settings.videoModels} videoWishLibrary={settings.videoWishLibrary}
          specialTags={settings.specialTags}
          sunoBasePrompt={settings.sunoBasePrompt} sunoPromptPresets={settings.sunoPromptPresets}
          referenceExamples={settings.referenceExamples} wishLibrary={settings.wishLibrary}
          requestTimeoutSeconds={settings.requestTimeoutSeconds}
          sceneBasePromptNarrative={settings.sceneBasePromptNarrative} sceneBasePromptAbstract={settings.sceneBasePromptAbstract}
          sceneWishLibrary={settings.sceneWishLibrary}
          backgroundRemoverParams={settings.backgroundRemoverParams} logos={settings.logos}
          backgroundRemoverMethod={settings.backgroundRemoverMethod}
          backgroundRemoverLocalParams={settings.backgroundRemoverLocalParams}
          backgroundRemoverFalParams={settings.backgroundRemoverFalParams}
          outpaintQualityMode={settings.outpaintQualityMode} musicTags={settings.musicTags}
          sunoBasePromptUserPresets={settings.sunoBasePromptUserPresets}
          murekaBasePromptUserPresets={settings.murekaBasePromptUserPresets}
          pricing={usage.pricing} usageToday={usage.today} usagePeriodTotals={usage.periodTotals}
          onLoadUsagePeriodTotals={usage.actions.loadPeriodTotals}
          miniPlayerTrack={miniPlayer.state.track} miniPlayerIsPlaying={miniPlayer.state.isPlaying}
          onToggleMiniPlayer={miniPlayer.actions.toggle}
          onClose={closeSettings} onOpenUsage={openUsage}
          actions={{ ...settings.actions, savePricingOverrides: usage.actions.savePricingOverrides, refreshPricing: usage.actions.refreshPricing }}
        />
      )}

      {screen === 'usage' && (
        <UsageScreen L={L} usage={usage} onClose={closeUsage} />
      )}

      <Toast message={toast} />
      <audio {...miniPlayer.audioProps} style={{ display: 'none' }} />
    </div>
  );
}

export default App;

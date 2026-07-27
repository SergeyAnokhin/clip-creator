import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api/client.js';
import { DICT } from './i18n/dict.js';
import {
  cloneBlockWithType, deleteLine, duplicateLine, insertBlockAdjacent, moveBlock, moveBlockToEdge, moveToEdgeForType,
  repeatChorusAfterVerses, setLine, splitBlockAtLine, splitBlockEveryN, toggleLineBrackets,
} from './lib/lyrics.js';
import { debounce } from './lib/debounce.js';
import HomeScreen from './components/home/HomeScreen.jsx';
import WorkflowScreen from './components/workflow/WorkflowScreen.jsx';
import SettingsScreen from './components/settings/SettingsScreen.jsx';
import Toast from './components/Toast.jsx';
import './styles/theme.css';

const VOICE_RECORDING_MS = 2400;

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function App() {
  const [screen, setScreen] = useState('home');
  const [prevScreen, setPrevScreen] = useState('home');
  const [viewport, setViewport] = useState('desktop');
  const [lang, setLang] = useState('ru');
  const [toast, setToast] = useState(null);

  const [projects, setProjects] = useState([]);
  const [homeFilter, setHomeFilter] = useState('all');
  const [homeSearch, setHomeSearch] = useState('');
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [modalUrl, setModalUrl] = useState('');
  const [modalRawText, setModalRawText] = useState('');
  const [modalLoading, setModalLoading] = useState(false);

  const [activeProject, setActiveProject] = useState(null);
  const [activeStage, setActiveStage] = useState('lyrics');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [editingBlockId, setEditingBlockId] = useState(null);
  const [draftContent, setDraftContent] = useState('');
  const [editingLineBlockId, setEditingLineBlockId] = useState(null);
  const [editingLineIndex, setEditingLineIndex] = useState(null);
  const [lineDraft, setLineDraft] = useState('');
  const [openMenuTypeBlockId, setOpenMenuTypeBlockId] = useState(null);
  const [openMenuCloneBlockId, setOpenMenuCloneBlockId] = useState(null);
  const [openTagMenuBlockId, setOpenTagMenuBlockId] = useState(null);
  const [splitGroupSize, setSplitGroupSize] = useState(4);

  const [recordingKind, setRecordingKind] = useState(null);
  const [recordingTarget, setRecordingTarget] = useState(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const [skillId, setSkillId] = useState('skill_a');
  const [refinementText, setRefinementText] = useState('');
  const [sunoLoading, setSunoLoading] = useState(false);
  const [trackUrl, setTrackUrl] = useState('');

  const [imageModel, setImageModel] = useState('flux');
  const [sceneLoadingIdx, setSceneLoadingIdx] = useState(null);

  const [apiKeys, setApiKeys] = useState({ openai: '', anthropic: '', deepseek: '', replicate: '' });
  const [textModelDefault, setTextModelDefault] = useState('claude');
  const [imageModelDefault, setImageModelDefault] = useState('flux');
  const [specialTags, setSpecialTags] = useState(['[Vocal Interlude]', '[Female vocal interlude]']);

  const recInterval = useRef(null);
  const recTimeout = useRef(null);
  const toastTimer = useRef(null);

  const L = DICT[lang];
  const langLabel = lang === 'ru' ? 'EN' : 'RU';

  // ---------- bootstrap ----------
  useEffect(() => {
    api.getSettings().then((s) => {
      setLang(s.lang || 'ru');
      setApiKeys(s.api_keys || {});
      setTextModelDefault(s.text_model_default || 'claude');
      setImageModelDefault(s.image_model_default || 'flux');
      setSpecialTags(s.special_tags || ['[Vocal Interlude]', '[Female vocal interlude]']);
    }).catch(() => {});
    refreshProjects();
  }, []);

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
    return () => {
      window.removeEventListener('resize', onResize);
      clearInterval(recInterval.current);
      clearTimeout(recTimeout.current);
      clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message) {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  async function refreshProjects() {
    try {
      setProjects(await api.listProjects());
    } catch {
      showToast('Не удалось загрузить проекты');
    }
  }

  // ---------- project persistence ----------
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

  // ---------- home ----------
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

  async function openProject(id) {
    try {
      const project = await api.getProject(id);
      setActiveProject(project);
      setActiveStage('lyrics');
      setSidebarOpen(viewport !== 'mobile');
      setSkillId('skill_a');
      setRefinementText('');
      setTrackUrl(project.track_url || '');
      setScreen('workflow');
    } catch {
      showToast('Не удалось открыть проект');
    }
  }

  async function goHome() {
    setScreen('home');
    setActiveProject(null);
    refreshProjects();
  }

  function openSettings() { setPrevScreen(screen); setScreen('settings'); }
  function closeSettings() { setScreen(prevScreen); }
  function toggleLang() { setLang((l) => (l === 'ru' ? 'en' : 'ru')); }
  function toggleSidebar() { setSidebarOpen((s) => !s); }
  function closeSidebarMobile() { setSidebarOpen(false); }
  function selectStage(stage) { setActiveStage(stage); }

  // ---------- lyrics stage ----------
  function addBlock() {
    updateProject((p) => ({
      ...p,
      blocks: [...p.blocks, { id: randomId('blk'), type: 'verse', importance: 3, content: 'Новый блок текста...' }],
    }));
  }
  function moveBlockAction(id, dir) {
    updateProject((p) => ({ ...p, blocks: moveBlock(p.blocks, id, dir) }));
  }
  function moveBlockToEdgeAction(id, edge) {
    updateProject((p) => ({ ...p, blocks: moveBlockToEdge(p.blocks, id, edge) }));
  }
  function splitBlock(id, lineIndex) {
    updateProject((p) => ({ ...p, blocks: splitBlockAtLine(p.blocks, id, lineIndex, randomId('blk')) }));
  }
  function splitIntoGroups(id, n) {
    updateProject((p) => ({ ...p, blocks: splitBlockEveryN(p.blocks, id, n, () => randomId('blk')) }));
  }
  function toggleTypeMenu(id) {
    setOpenMenuTypeBlockId((cur) => (cur === id ? null : id));
    setOpenMenuCloneBlockId(null);
  }
  function toggleCloneMenu(id) {
    setOpenMenuCloneBlockId((cur) => (cur === id ? null : id));
    setOpenMenuTypeBlockId(null);
  }
  function setBlockType(id, type) {
    updateProject((p) => ({
      ...p,
      blocks: moveToEdgeForType(p.blocks.map((b) => (b.id === id ? { ...b, type } : b)), id, type),
    }));
    setOpenMenuTypeBlockId(null);
  }
  function cloneBlockAsType(id, type) {
    updateProject((p) => ({ ...p, blocks: cloneBlockWithType(p.blocks, id, type, randomId('blk')) }));
    setOpenMenuCloneBlockId(null);
    showToast(L.toast_duplicated);
  }
  function toggleLineBracket(blockId, lineIndex) {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, content: toggleLineBrackets(b.content, lineIndex) } : b)),
    }));
  }
  function toggleTagMenu(id) { setOpenTagMenuBlockId((cur) => (cur === id ? null : id)); }
  function insertTagBlock(afterId, tagText, position) {
    updateProject((p) => ({
      ...p,
      blocks: insertBlockAdjacent(p.blocks, afterId, 'interlude', tagText, position, randomId('blk')),
    }));
    setOpenTagMenuBlockId(null);
  }
  function startEditBlock(id, content) { setEditingBlockId(id); setDraftContent(content); }
  function saveEditBlock() {
    updateProject((p) => ({ ...p, blocks: p.blocks.map((b) => (b.id === editingBlockId ? { ...b, content: draftContent } : b)) }));
    setEditingBlockId(null);
  }
  function cancelEditBlock() { setEditingBlockId(null); }
  function startEditLine(blockId, lineIndex, content) {
    setEditingLineBlockId(blockId);
    setEditingLineIndex(lineIndex);
    setLineDraft(content);
  }
  function saveEditLine() {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (
        b.id === editingLineBlockId ? { ...b, content: setLine(b.content, editingLineIndex, lineDraft) } : b
      )),
    }));
    setEditingLineBlockId(null);
    setEditingLineIndex(null);
  }
  function cancelEditLine() { setEditingLineBlockId(null); setEditingLineIndex(null); }
  function duplicateLineAction(blockId, lineIndex) {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, content: duplicateLine(b.content, lineIndex) } : b)),
    }));
  }
  function deleteLineAction(blockId, lineIndex) {
    updateProject((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, content: deleteLine(b.content, lineIndex) } : b)),
    }));
  }
  function duplicateBlock(id) {
    updateProject((p) => {
      const idx = p.blocks.findIndex((b) => b.id === id);
      const copy = { ...p.blocks[idx], id: randomId('blk') };
      return { ...p, blocks: [...p.blocks.slice(0, idx + 1), copy, ...p.blocks.slice(idx + 1)] };
    });
    showToast(L.toast_duplicated);
  }
  function deleteBlock(id) {
    updateProject((p) => ({ ...p, blocks: p.blocks.filter((b) => b.id !== id) }));
    showToast(L.toast_deleted);
  }
  function repeatChorus() {
    updateProject((p) => ({ ...p, blocks: repeatChorusAfterVerses(p.blocks, () => randomId('blk')) }));
    showToast(L.toast_chorusRepeated);
  }

  // ---------- voice simulation (block / refinement / scene) ----------
  function startVoice(kind, target) {
    clearInterval(recInterval.current);
    clearTimeout(recTimeout.current);
    setRecordingKind(kind);
    setRecordingTarget(target ?? null);
    setRecordingSeconds(0);
    recInterval.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    recTimeout.current = setTimeout(() => stopVoice(kind, target), VOICE_RECORDING_MS);
  }
  function stopVoice(kind, target) {
    clearInterval(recInterval.current);
    if (kind === 'block') {
      updateProject((p) => ({
        ...p,
        blocks: p.blocks.map((b) => (b.id === target ? { ...b, content: `${b.content}\n[+ голосом: усильте образность строфы]` } : b)),
      }));
    } else if (kind === 'refinement') {
      setRefinementText('Добавь больше джазовых акцентов и сделай упор на саксофонные соло');
    } else if (kind === 'scene') {
      updateProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i === target ? { ...s, static_prompt: `${s.static_prompt}, dramatic fog and neon rim light` } : s)),
      }));
    }
    setRecordingKind(null);
    setRecordingTarget(null);
    showToast(L.toast_voice);
  }

  // ---------- suno stage ----------
  function setSkillPrompt(value) {
    updateProject((p) => ({ ...p, skill_prompt: value }), { immediate: false });
  }
  function applyRefinement() {
    if (!refinementText.trim()) return;
    const addition = `\n// Refined: ${refinementText}`;
    updateProject((p) => ({ ...p, skill_prompt: p.skill_prompt + addition }));
    setRefinementText('');
    showToast(L.toast_generated);
  }
  async function generateSuno() {
    if (!activeProject) return;
    setSunoLoading(true);
    try {
      const result = await api.generateSuno(activeProject.id);
      setActiveProject((p) => ({ ...p, style: result.style, lyrics: result.lyrics }));
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось сгенерировать');
    } finally {
      setSunoLoading(false);
    }
  }
  function copyStyle() {
    navigator.clipboard?.writeText(activeProject?.style || '').catch(() => {});
    showToast(L.toast_copied);
  }
  function copyLyrics() {
    navigator.clipboard?.writeText(activeProject?.lyrics || '').catch(() => {});
    showToast(L.toast_copied);
  }
  function saveTrackUrl() {
    updateProject((p) => ({ ...p, track_url: trackUrl }));
    showToast(L.toast_saved);
  }

  // ---------- scenes stage ----------
  function onSceneStaticChange(idx, value) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i === idx ? { ...s, static_prompt: value } : s)),
    }), { immediate: false });
  }
  function onSceneMotionChange(idx, value) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i === idx ? { ...s, motion_prompt: value } : s)),
    }), { immediate: false });
  }
  async function generateSceneImages(idx) {
    if (!activeProject) return;
    setSceneLoadingIdx(idx);
    try {
      const result = await api.generateSceneImages(activeProject.id, idx);
      setActiveProject((p) => ({
        ...p,
        scenes: p.scenes.map((s, i) => (i === idx ? { ...s, images: result.images } : s)),
      }));
      showToast(L.toast_generated);
    } catch {
      showToast('Не удалось сгенерировать изображения');
    } finally {
      setSceneLoadingIdx(null);
    }
  }
  async function regenerateAllScenes() {
    if (!activeProject) return;
    await Promise.all(activeProject.scenes.map((_, idx) => generateSceneImages(idx)));
  }
  function rateImage(sceneIdx, imgIdx, rating) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : {
        ...s,
        images: s.images.map((img, j) => (j === imgIdx ? { ...img, rating } : img)),
      })),
    }));
  }
  function selectMainImage(sceneIdx, imgIdx) {
    updateProject((p) => ({
      ...p,
      scenes: p.scenes.map((s, i) => (i !== sceneIdx ? s : {
        ...s,
        images: s.images.map((img, j) => ({ ...img, main: j === imgIdx })),
      })),
    }));
  }

  // ---------- settings ----------
  function setApiKey(key, value) { setApiKeys((prev) => ({ ...prev, [key]: value })); }
  function addSpecialTag(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSpecialTags((prev) => [...prev, trimmed]);
  }
  function removeSpecialTag(index) {
    setSpecialTags((prev) => prev.filter((_, i) => i !== index));
  }
  async function saveSettings() {
    try {
      await api.putSettings({
        lang, api_keys: apiKeys, text_model_default: textModelDefault, image_model_default: imageModelDefault,
        special_tags: specialTags,
      });
      showToast(L.toast_saved);
    } catch {
      showToast('Не удалось сохранить настройки');
    }
  }

  const lyricsState = {
    editingBlockId, draftContent, openMenuTypeBlockId, openMenuCloneBlockId, openTagMenuBlockId,
    specialTags, splitGroupSize,
    editingLineBlockId, editingLineIndex, lineDraft,
    recordingBlockId: recordingKind === 'block' ? recordingTarget : null,
    recordingSeconds,
    actions: {
      addBlock, moveBlock: moveBlockAction, moveBlockToEdge: moveBlockToEdgeAction, splitBlock, splitIntoGroups, setSplitGroupSize,
      toggleTypeMenu, setBlockType, toggleCloneMenu, cloneBlockAsType, toggleLineBracket, repeatChorus,
      toggleTagMenu, insertTagBlock,
      startVoice, duplicateBlock, deleteBlock,
      startEditBlock, saveEditBlock, cancelEditBlock, setDraftContent,
      startEditLine, saveEditLine, cancelEditLine, setLineDraft, duplicateLine: duplicateLineAction,
      deleteLine: deleteLineAction,
    },
  };

  const sunoState = {
    skillId, refinementText,
    isRecordingRefinement: recordingKind === 'refinement',
    recordingSeconds, sunoLoading, trackUrl,
    actions: {
      selectSkill: setSkillId, setSkillPrompt, setRefinementText, startVoice, applyRefinement,
      generateSuno, copyStyle, copyLyrics, setTrackUrl, saveTrackUrl,
    },
  };

  const scenesState = {
    imageModel,
    sceneLoadingIdx,
    sceneRecordingIdx: recordingKind === 'scene' ? recordingTarget : null,
    recordingSeconds,
    actions: {
      selectImageModel: setImageModel, regenerateAll: regenerateAllScenes,
      onStaticChange: onSceneStaticChange, onMotionChange: onSceneMotionChange,
      onGenerate: generateSceneImages, onVoiceEdit: (idx) => startVoice('scene', idx),
      onSelectMain: selectMainImage, onRate: rateImage,
    },
  };

  return (
    <div className="app-shell">
      {screen === 'home' && (
        <HomeScreen
          L={L} lang={lang} langLabel={langLabel} viewport={viewport}
          projects={projects} homeFilter={homeFilter} homeSearch={homeSearch}
          showNewProjectModal={showNewProjectModal} modalUrl={modalUrl} modalRawText={modalRawText} modalLoading={modalLoading}
          onToggleLang={toggleLang} onOpenSettings={openSettings}
          onOpenNewProjectModal={openNewProjectModal} onCloseNewProjectModal={closeNewProjectModal}
          onModalUrlChange={setModalUrl} onModalRawTextChange={setModalRawText} onSubmitNewProject={submitNewProject}
          onFilterChange={setHomeFilter} onSearchChange={setHomeSearch}
          onOpenProject={openProject} onDeleteProject={deleteProject}
        />
      )}

      {screen === 'workflow' && activeProject && (
        <WorkflowScreen
          L={L} langLabel={langLabel} viewport={viewport}
          project={activeProject} activeStage={activeStage} sidebarOpen={sidebarOpen}
          lyricsState={lyricsState} sunoState={sunoState} scenesState={scenesState}
          onGoHome={goHome} onToggleSidebar={toggleSidebar} onCloseSidebarMobile={closeSidebarMobile}
          onToggleLang={toggleLang} onOpenSettings={openSettings} onSelectStage={selectStage}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          L={L} lang={lang} apiKeys={apiKeys} textModelDefault={textModelDefault} imageModelDefault={imageModelDefault}
          specialTags={specialTags}
          onClose={closeSettings}
          actions={{
            setLangRu: () => setLang('ru'), setLangEn: () => setLang('en'),
            setApiKey, setTextModelDefault, setImageModelDefault, onSave: saveSettings,
            addSpecialTag, removeSpecialTag,
          }}
        />
      )}

      <Toast message={toast} />
    </div>
  );
}

export default App;

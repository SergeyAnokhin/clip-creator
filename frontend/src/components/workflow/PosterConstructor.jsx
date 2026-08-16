import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Maximize2, Minimize2, Minus, Plus, Redo2, Save, Square, Type, Undo2, X,
} from 'lucide-react';
import { Group, Image as KonvaImage, Layer, Line, Stage } from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { onBackdropClick } from '../../lib/a11y.js';
import {
  ZOOM_STEP, clampZoom, defaultTextFontSize, genId, makeDefaultGlass, makeLayer, makeMagicLayer, makeTextLayer,
  moveLayerInList, normalizeLayers, normalizeMagicLayers, normalizeTextLayers, parseTextBlock, roundRectPath,
} from '../../lib/posterLayers.js';
import { MagicLayerNode, OverlayGlass, OverlayImage, OverlayText } from './PosterCanvasLayers.jsx';
import {
  EffectsPanel, GlassPanel, LayerToolbar, MagicLayersPanel, PickerRow, PickerThumb, TextLayerPanel,
} from './PosterPanels.jsx';

const MAX_DISPLAY_W = 760;
const MAX_DISPLAY_H = 520;
// Fixed (non-growing) side panel width, in both modes, so expanding to
// fullscreen grows only the picture area, not the tools column. Wide enough
// for 4 thumbnails per row without wrapping.
const SIDE_PANEL_WIDTH = 300;
// Reserve (viewport px) subtracted from the fullscreen picture budget for
// the panel + gaps + the (edge-to-edge, fullscreen-only) modal-card's own
// small horizontal padding - see the fullscreen branch of modal-card's
// inline style below.
const SIDE_PANEL_RESERVE = 360;
// In fullscreen the header bar is removed entirely (see the fullscreen
// branch below) so the picture can span the full viewport height - only a
// thin bottom padding is reserved, no room for a title bar.
const FULLSCREEN_V_RESERVE = 24;

/** Extra canvas room (screen px) kept around the poster's visible bounds so
 * overlay objects (e.g. the glass panel below) can be dragged past the
 * poster edge and still be seen while editing - purely an editor
 * convenience. Cropped back out at export time (see handleSave), so the
 * saved poster is always exactly `canvasSize`. */
const OVERFLOW_MARGIN = 40;
const OVERFLOW_MARGIN_FULLSCREEN = 100;

/** Undo/redo history depth (oldest snapshots drop off past this). */
const MAX_HISTORY = 50;

export default function PosterConstructor({
  L, projectId, candidates, variants, logos, initialPoster, saving, onSave, onClose, textBlock,
  posterTemplates = [], onSaveTemplate, onDeleteTemplate,
  magicLayerGroups = [], magicBusySources, onDecomposeMagicLayers, onDeleteMagicLayerGroup,
}) {
  const [backgroundPath, setBackgroundPath] = useState(initialPoster?.background_path || candidates[0] || null);
  const [titleCardVariantId, setTitleCardVariantId] = useState(initialPoster?.title_card_variant_id || variants[0]?.variant_id || null);
  const [logoId, setLogoId] = useState(initialPoster?.logo_id || null);
  const [titleLayers, setTitleLayers] = useState(() => normalizeLayers(initialPoster?.layers?.title_card));
  const [logoLayers, setLogoLayers] = useState(() => normalizeLayers(initialPoster?.layers?.logo));
  const [glassLayer, setGlassLayer] = useState(initialPoster?.layers?.glass || null);
  const [textLayers, setTextLayers] = useState(() => normalizeTextLayers(initialPoster?.layers?.text));
  const [magicLayers, setMagicLayers] = useState(() => normalizeMagicLayers(initialPoster?.layers?.magic));
  // A decomposition already contains the whole source image, so the flat
  // original underneath it has to stop rendering - otherwise it shows through
  // as soon as a magic layer is moved away, which is exactly the hole this
  // feature exists to avoid. The background image stays *loaded* either way:
  // canvasSize and the export pixelRatio are derived from its natural size.
  const [hideBackground, setHideBackground] = useState(!!initialPoster?.layers?.hide_background);
  const [hideTitleCard, setHideTitleCard] = useState(!!initialPoster?.layers?.hide_title_card);
  const [selected, setSelected] = useState(null); // {kind:'title'|'logo'|'text'|'magic', id} | {kind:'glass'} | null
  const [cropEditing, setCropEditing] = useState(null); // {kind, id} | null
  const [fullscreen, setFullscreen] = useState(false);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [zoom, setZoom] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [guides, setGuides] = useState({ v: false, h: false });
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [templateNameDraft, setTemplateNameDraft] = useState('');
  const lastCommitAt = useRef(0);
  const stageRef = useRef(null);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fullscreen]);

  // A zoom/pan applied under one background/one screen size doesn't mean
  // anything once either changes - start fresh rather than leaving the view
  // panned off into empty space.
  useEffect(() => {
    setZoom(1);
    setStagePos({ x: 0, y: 0 });
  }, [fullscreen, backgroundPath]);

  // `?canvas` distinguishes these fetches from the plain <img> tags the
  // picker thumbnails below use for the exact same URLs - two different
  // fetch modes (plain <img> vs useHtmlImage's CORS-mode fetch, see its
  // docstring) racing for the same URL at mount time was observed to fail
  // one of them with net::ERR_FAILED (confirmed in this app's dev session,
  // 2026-08); the query string is ignored by the backend's static file
  // serving, so this only affects the browser's cache key, not the request.
  const bg = useHtmlImage(backgroundPath ? `${mediaUrl(`projects/${projectId}/${backgroundPath}`)}?canvas` : null);
  const titleVariant = variants.find((v) => v.variant_id === titleCardVariantId);
  const titleImg = useHtmlImage(titleVariant ? `${mediaUrl(`projects/${projectId}/${titleVariant.file_path}`)}?canvas` : null);
  const logo = logos.find((l) => l.id === logoId);
  const logoImg = useHtmlImage(logo ? `${mediaUrl(logo.file_path)}?canvas` : null);

  // In fullscreen, the picture area grows to fill essentially the whole
  // viewport (the side panel itself stays SIDE_PANEL_WIDTH wide - see its
  // style below - rather than also growing and eating the extra space).
  const maxDisplayW = fullscreen ? Math.max(320, viewport.w - SIDE_PANEL_RESERVE) : MAX_DISPLAY_W;
  const maxDisplayH = fullscreen ? Math.max(240, viewport.h - FULLSCREEN_V_RESERVE) : MAX_DISPLAY_H;
  const scale = bg.width ? Math.min(1, maxDisplayW / bg.width, maxDisplayH / bg.height) : 1;
  const displayW = Math.round((bg.width || maxDisplayW) * scale);
  const displayH = Math.round((bg.height || maxDisplayH) * scale);
  const overflowMargin = fullscreen ? OVERFLOW_MARGIN_FULLSCREEN : OVERFLOW_MARGIN;
  const marginLocal = scale ? overflowMargin / scale : 0;
  const effectiveScale = scale * zoom;
  const stageW = displayW + overflowMargin * 2;
  const stageH = displayH + overflowMargin * 2;

  // Default-place a freshly picked overlay (no layers yet) once both its
  // image and the background's natural size are known.
  useEffect(() => {
    if (titleImg.image && titleLayers.length === 0 && bg.width) {
      const s = (bg.width * 0.6) / titleImg.width;
      setTitleLayers([makeLayer({
        x: (bg.width - titleImg.width * s) / 2, y: (bg.height - titleImg.height * s) / 2,
        scaleX: s, scaleY: s,
      })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleImg.image, bg.width]);

  useEffect(() => {
    if (logoImg.image && logoId && logoLayers.length === 0 && bg.width) {
      const s = (bg.width * 0.18) / logoImg.width;
      setLogoLayers([makeLayer({ x: bg.width * 0.04, y: bg.height * 0.04, scaleX: s, scaleY: s })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoImg.image, logoId, bg.width]);

  /** Undo/redo: a single choke point every document mutation runs through.
   * Snapshots the pre-mutation document into `past` (clearing `future`,
   * since a fresh edit invalidates any redo branch) before applying
   * `mutate` - unless the previous commit was under 400ms ago, in which
   * case it's coalesced into that same snapshot instead of pushing a new
   * one. That coalescing is what keeps a single slider/color/text-field
   * drag (which re-fires this on every tick) from flooding the history
   * with one entry per pixel/keystroke - see the plan's rationale. */
  function currentDoc() {
    return {
      backgroundPath, titleCardVariantId, logoId, titleLayers, logoLayers, glassLayer, textLayers,
      magicLayers, hideBackground, hideTitleCard,
    };
  }
  function applyDoc(doc) {
    setBackgroundPath(doc.backgroundPath);
    setTitleCardVariantId(doc.titleCardVariantId);
    setLogoId(doc.logoId);
    setTitleLayers(doc.titleLayers);
    setLogoLayers(doc.logoLayers);
    setGlassLayer(doc.glassLayer);
    setTextLayers(doc.textLayers);
    setMagicLayers(doc.magicLayers);
    setHideBackground(doc.hideBackground);
    setHideTitleCard(doc.hideTitleCard);
  }
  function commit(mutate) {
    const now = Date.now();
    if (now - lastCommitAt.current > 400) {
      setPast((p) => [...p, currentDoc()].slice(-MAX_HISTORY));
      setFuture([]);
    }
    lastCommitAt.current = now;
    mutate();
  }
  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [currentDoc(), ...f]);
    setPast((p) => p.slice(0, -1));
    applyDoc(prev);
    lastCommitAt.current = 0;
    setSelected(null);
    setCropEditing(null);
  }
  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, currentDoc()]);
    setFuture((f) => f.slice(1));
    applyDoc(next);
    lastCommitAt.current = 0;
    setSelected(null);
    setCropEditing(null);
  }

  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // undo/redo intentionally omitted: they're recreated every render but only
    // *do* anything different once past/future change, so resubscribing on
    // those two (rather than every render - e.g. every drag-guide update) is
    // the actual intent, not an oversight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, future]);

  // Magic layers are slices of one specific source image, so switching that
  // source drops them (and the "hide the flat original" flags they set) -
  // keeping them would leave pieces of the previous picture floating over the
  // new one.
  function pickBackground(path) {
    commit(() => {
      setBackgroundPath(path);
      setMagicLayers([]);
      setHideBackground(false);
      setSelected(null);
      setCropEditing(null);
    });
  }
  function pickTitleCard(variantId) {
    commit(() => {
      setTitleCardVariantId(variantId);
      setTitleLayers([]);
      setMagicLayers([]);
      setHideTitleCard(false);
      setSelected(null);
      setCropEditing(null);
    });
  }
  function pickLogo(id) {
    commit(() => {
      setLogoId(id);
      setLogoLayers([]);
      setSelected(null);
      setCropEditing(null);
    });
  }
  function addGlass() {
    if (!bg.width || glassLayer) return;
    commit(() => { setGlassLayer(makeDefaultGlass(bg.width, bg.height)); setSelected({ kind: 'glass' }); });
  }
  function removeGlass() {
    commit(() => { setGlassLayer(null); setSelected((s) => (s?.kind === 'glass' ? null : s)); });
  }

  function addTextLayer(textType) {
    if (!bg.width) return;
    commit(() => {
      const defaults = parseTextBlock(textBlock);
      const fallback = { title: L.poster_defaultTitleText, author: L.poster_defaultAuthorText };
      const layer = makeTextLayer(textType, bg, defaults, fallback);
      setTextLayers((list) => [...list, layer]);
      setSelected({ kind: 'text', id: layer.id });
    });
  }

  /** Applies a saved poster template (logo + glass + text layers only -
   * see settings.py's `poster_templates` doc comment for why the background
   * and title-card layers are deliberately excluded, they're specific to
   * the poem this poster happens to be for). Regenerates fresh layer ids so
   * the applied copies are independently editable from whatever the
   * template itself might still be re-applied onto later. */
  function applyTemplate(id) {
    const tpl = posterTemplates.find((t) => t.id === id);
    if (!tpl?.layers) return;
    commit(() => {
      const { layers } = tpl;
      setLogoId(layers.logo_id ?? null);
      setLogoLayers(normalizeLayers(layers.logo).map((l) => ({ ...l, id: genId() })));
      setGlassLayer(layers.glass ? { ...layers.glass } : null);
      setTextLayers(normalizeTextLayers(layers.text).map((l) => ({ ...l, id: genId() })));
      setSelected(null);
      setCropEditing(null);
    });
  }

  function saveCurrentAsTemplate() {
    const trimmed = templateNameDraft.trim();
    if (!trimmed || !onSaveTemplate) return;
    onSaveTemplate(trimmed, { logo_id: logoId, logo: logoLayers, glass: glassLayer, text: textLayers });
    setTemplateNameDraft('');
  }

  function layerListFor(kind) {
    if (kind === 'title') return [titleLayers, setTitleLayers];
    if (kind === 'logo') return [logoLayers, setLogoLayers];
    if (kind === 'magic') return [magicLayers, setMagicLayers];
    return [textLayers, setTextLayers];
  }

  /** Turns one decomposed group into N movable layers. A group made from the
   * current background lands at identity (same canvas, so the pieces sit
   * exactly where they were in the original); one made from anything else
   * (e.g. a title-card variant) is scaled and centered like a freshly picked
   * title-card overlay. Applying also hides whichever flat image the group
   * came from - see `hideBackground`'s comment. */
  function applyMagicGroup(group) {
    if (!group || !bg.width) return;
    const fromBackground = group.source_path === backgroundPath;
    const canvasW = group.canvas?.width || bg.width;
    const scaleFactor = fromBackground ? 1 : (bg.width * 0.6) / canvasW;
    const canvasH = group.canvas?.height || bg.height;
    commit(() => {
      setMagicLayers(group.layers.map((l) => makeMagicLayer({
        groupId: group.group_id, index: l.index, filePath: l.file_path, isBackground: l.is_background,
      })).map((layer) => ({
        ...layer,
        scaleX: scaleFactor, scaleY: scaleFactor,
        x: fromBackground ? 0 : (bg.width - canvasW * scaleFactor) / 2,
        y: fromBackground ? 0 : (bg.height - canvasH * scaleFactor) / 2,
      })));
      if (fromBackground) setHideBackground(true); else setHideTitleCard(true);
      setSelected(null);
      setCropEditing(null);
    });
  }

  function clearMagicLayers() {
    commit(() => {
      setMagicLayers([]);
      setHideBackground(false);
      setHideTitleCard(false);
      setSelected(null);
      setCropEditing(null);
    });
  }

  function moveMagicLayer(id, delta) {
    commit(() => setMagicLayers((list) => moveLayerInList(list, list.findIndex((l) => l.id === id), delta)));
  }

  function updateLayer(kind, id, patch) {
    commit(() => {
      const [, setList] = layerListFor(kind);
      setList((list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    });
  }

  function duplicateLayer(kind, id) {
    commit(() => {
      const [list, setList] = layerListFor(kind);
      const src = list.find((l) => l.id === id);
      if (!src) return;
      const copy = {
        ...src, id: genId(), x: src.x + 24, y: src.y + 24,
        effects: { glow: { ...src.effects.glow }, clone: { ...src.effects.clone }, opacity: src.effects.opacity },
        ...(kind !== 'text' ? { crop: src.crop ? { ...src.crop } : null } : {}),
      };
      setList([...list, copy]);
      setSelected({ kind, id: copy.id });
      setCropEditing(null);
    });
  }

  function deleteLayer(kind, id) {
    commit(() => {
      const [, setList] = layerListFor(kind);
      setList((list) => list.filter((l) => l.id !== id));
      setSelected(null);
      setCropEditing(null);
    });
  }

  function zoomAtPoint(pointer, factor) {
    const oldScale = scale * zoom;
    const newZoom = clampZoom(zoom * factor);
    const newScale = scale * newZoom;
    const mousePointTo = { x: (pointer.x - stagePos.x) / oldScale, y: (pointer.y - stagePos.y) / oldScale };
    setZoom(newZoom);
    setStagePos({ x: pointer.x - mousePointTo.x * newScale, y: pointer.y - mousePointTo.y * newScale });
  }
  function handleWheel(e) {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    zoomAtPoint(pointer, e.evt.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }
  function zoomButton(factor) {
    zoomAtPoint({ x: stageW / 2, y: stageH / 2 }, factor);
  }
  function resetZoom() { setZoom(1); setStagePos({ x: 0, y: 0 }); }

  /** Builds the real (blurred) frosted-glass tile that replaces the cheap
   * live-preview tint for export. Runs once at save time only - a live
   * backdrop blur redrawn every drag frame would be too slow.
   *
   * Konva rotates a Group around its own (x,y), i.e. the panel's top-left
   * corner, not its center. Rather than hand-deriving that rotated sampling
   * transform (easy to get a sign wrong in), the background is first
   * de-rotated as a whole around that same pivot point (a plain, easily
   * verified `ctx.rotate` around a fixed point), which leaves the glass
   * panel's footprint sitting axis-aligned at that pivot - then it's just a
   * rectangular crop. */
  function buildHqGlassCanvas(bigCanvas, glass, exportRatio, marginPx) {
    const pivotX = marginPx + glass.x;
    const pivotY = marginPx + glass.y;
    const localW = Math.max(1, Math.round(glass.width * glass.scaleX));
    const localH = Math.max(1, Math.round(glass.height * glass.scaleY));
    const rotRad = (glass.rotation * Math.PI) / 180;

    const derotated = document.createElement('canvas');
    derotated.width = bigCanvas.width;
    derotated.height = bigCanvas.height;
    const dctx = derotated.getContext('2d');
    dctx.translate(pivotX, pivotY);
    dctx.rotate(-rotRad);
    dctx.translate(-pivotX, -pivotY);
    dctx.drawImage(bigCanvas, 0, 0);

    const target = document.createElement('canvas');
    target.width = localW;
    target.height = localH;
    const tctx = target.getContext('2d');
    const blurPx = (glass.thickness / 100) * 18 * exportRatio;
    tctx.filter = blurPx > 0.1 ? `blur(${blurPx}px)` : 'none';
    tctx.drawImage(derotated, pivotX, pivotY, localW, localH, 0, 0, localW, localH);
    tctx.filter = 'none';

    const r = Math.min(glass.cornerRadius * glass.scaleX, localW / 2, localH / 2);
    roundRectPath(tctx, 0, 0, localW, localH, r);
    tctx.save();
    tctx.clip();
    tctx.fillStyle = `rgba(255,255,255,${glass.opacity})`;
    tctx.fillRect(0, 0, localW, localH);
    tctx.restore();

    const strokeWidth = (1 + (glass.thickness / 100) * 3) * exportRatio;
    const strokeOpacity = 0.25 + (glass.thickness / 100) * 0.5;
    tctx.lineWidth = strokeWidth;
    tctx.strokeStyle = `rgba(255,255,255,${strokeOpacity})`;
    roundRectPath(tctx, strokeWidth / 2, strokeWidth / 2, localW - strokeWidth, localH - strokeWidth, Math.max(0, r - strokeWidth / 2));
    tctx.stroke();

    return { canvas: target, localW, localH };
  }

  async function handleSave() {
    if (!backgroundPath || !titleCardVariantId || !bg.width || !stageRef.current) return;
    const stage = stageRef.current;
    const exportRatio = bg.width / displayW;
    const glassNode = glassLayer ? stage.findOne('.glass-group') : null;
    let hqImage = null;

    // The interactive zoom/pan is a view-only convenience - export always
    // renders the poster at its true fit scale and neutral position, same
    // as the crop/x/y math below (which assumes exactly that state).
    const prevScale = stage.scaleX();
    const prevPos = stage.position();
    stage.scale({ x: scale, y: scale });
    stage.position({ x: 0, y: 0 });

    // A selected layer's Transformer (drag/rotate handles) and any
    // in-progress crop editor are live Konva nodes in the same Layer being
    // flattened - hide them for the export or they bake into the saved PNG.
    const transformers = stage.find('Transformer');
    transformers.forEach((t) => t.hide());
    const cropEditorNodes = stage.find('.crop-editor');
    cropEditorNodes.forEach((n) => n.hide());

    if (glassNode) {
      glassNode.hide();
      stage.batchDraw();
      // Explicit x/y/width/height: toCanvas defaults to the stage's content
      // bounding box (via getClientRect) when omitted, which can start at a
      // non-zero origin - pinning it to the stage's own pixel rect keeps
      // this canvas's (0,0) matching the pivot math below.
      const bigCanvas = stage.toCanvas({ x: 0, y: 0, width: stage.width(), height: stage.height(), pixelRatio: exportRatio });
      const marginPx = overflowMargin * exportRatio;
      const { canvas, localW, localH } = buildHqGlassCanvas(bigCanvas, glassLayer, exportRatio, marginPx);
      hqImage = new Konva.Image({
        image: canvas, x: glassLayer.x, y: glassLayer.y, width: localW, height: localH, rotation: glassLayer.rotation,
      });
      const parent = glassNode.getParent();
      parent.add(hqImage);
      hqImage.setZIndex(glassNode.getZIndex());
      stage.batchDraw();
    }

    const blob = await stage.toBlob({
      x: overflowMargin, y: overflowMargin, width: displayW, height: displayH,
      pixelRatio: exportRatio, mimeType: 'image/png',
    });

    if (hqImage) hqImage.destroy();
    if (glassNode) glassNode.show();
    transformers.forEach((t) => t.show());
    cropEditorNodes.forEach((n) => n.show());
    stage.scale({ x: prevScale, y: prevScale });
    stage.position(prevPos);
    stage.batchDraw();

    onSave({
      blob, backgroundPath, titleCardVariantId, logoId,
      canvasSize: { width: bg.width, height: bg.height },
      layers: {
        title_card: titleLayers, logo: logoId ? logoLayers : null, glass: glassLayer, text: textLayers,
        magic: magicLayers, hide_background: hideBackground, hide_title_card: hideTitleCard,
      },
      posterId: initialPoster?.poster_id,
    });
  }

  const panelStyle = fullscreen
    // paddingTop reserves room for the floating Minimize2/X buttons
    // (top:10 + 30px tall, see the fullscreen branch below), which sit
    // directly over this panel's top-right corner and would otherwise
    // overlap the zoom/undo row that used to be the panel's first child.
    ? {
      flex: `0 0 ${SIDE_PANEL_WIDTH}px`, width: SIDE_PANEL_WIDTH, display: 'flex', flexDirection: 'column', gap: 14,
      overflowY: 'auto', minHeight: 0, paddingTop: 48,
    }
    : { flex: '1 1 220px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 14 };

  const pictureBox = (
    <div style={{ position: 'relative', width: displayW, height: displayH, flexShrink: 0 }}>
      <div
        style={{
          position: 'absolute', inset: 0, borderRadius: 8, overflow: 'hidden',
          background: 'repeating-conic-gradient(#2a2a2a 0% 25%, #363636 0% 50%) 50% / 16px 16px',
        }}
      />
      {bg.image && (
        <Stage
          ref={stageRef}
          width={stageW} height={stageH}
          style={{ position: 'absolute', left: -overflowMargin, top: -overflowMargin }}
          scaleX={effectiveScale} scaleY={effectiveScale}
          x={stagePos.x} y={stagePos.y}
          onWheel={handleWheel}
          onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelected(null); }}
          onTouchStart={(e) => { if (e.target === e.target.getStage()) setSelected(null); }}
        >
          <Layer>
            <Group x={marginLocal} y={marginLocal}>
              <KonvaImage image={bg.image} width={bg.width} height={bg.height} listening={false} visible={!hideBackground} />
              {magicLayers.map((layer) => (
                <MagicLayerNode
                  key={layer.id}
                  projectId={projectId} layer={layer}
                  isSelected={selected?.kind === 'magic' && selected.id === layer.id}
                  isCropEditing={cropEditing?.kind === 'magic' && cropEditing.id === layer.id}
                  onSelect={() => setSelected({ kind: 'magic', id: layer.id })}
                  onChange={(patch) => updateLayer('magic', layer.id, patch)}
                  onCropChange={(crop) => updateLayer('magic', layer.id, { crop })}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {glassLayer && (
                <OverlayGlass
                  transform={glassLayer} isSelected={selected?.kind === 'glass'}
                  onSelect={() => setSelected({ kind: 'glass' })} onChange={(next) => commit(() => setGlassLayer(next))}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              )}
              {!hideTitleCard && titleLayers.map((layer) => (
                <OverlayImage
                  key={layer.id}
                  image={titleImg.image} layer={layer}
                  isSelected={selected?.kind === 'title' && selected.id === layer.id}
                  isCropEditing={cropEditing?.kind === 'title' && cropEditing.id === layer.id}
                  onSelect={() => setSelected({ kind: 'title', id: layer.id })}
                  onChange={(patch) => updateLayer('title', layer.id, patch)}
                  onCropChange={(crop) => updateLayer('title', layer.id, { crop })}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {logoId && logoLayers.map((layer) => (
                <OverlayImage
                  key={layer.id}
                  image={logoImg.image} layer={layer}
                  isSelected={selected?.kind === 'logo' && selected.id === layer.id}
                  isCropEditing={cropEditing?.kind === 'logo' && cropEditing.id === layer.id}
                  onSelect={() => setSelected({ kind: 'logo', id: layer.id })}
                  onChange={(patch) => updateLayer('logo', layer.id, patch)}
                  onCropChange={(crop) => updateLayer('logo', layer.id, { crop })}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {textLayers.map((layer) => (
                <OverlayText
                  key={layer.id}
                  layer={layer}
                  isSelected={selected?.kind === 'text' && selected.id === layer.id}
                  onSelect={() => setSelected({ kind: 'text', id: layer.id })}
                  onChange={(patch) => updateLayer('text', layer.id, patch)}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {guides.v && (
                <Line
                  points={[bg.width / 2, 0, bg.width / 2, bg.height]}
                  stroke="#ff3b6f" strokeWidth={1.5 / effectiveScale}
                  dash={[8 / effectiveScale, 6 / effectiveScale]} listening={false}
                />
              )}
              {guides.h && (
                <Line
                  points={[0, bg.height / 2, bg.width, bg.height / 2]}
                  stroke="#ff3b6f" strokeWidth={1.5 / effectiveScale}
                  dash={[8 / effectiveScale, 6 / effectiveScale]} listening={false}
                />
              )}
            </Group>
          </Layer>
        </Stage>
      )}
    </div>
  );

  const selectedLayer = selected && ['title', 'logo', 'text', 'magic'].includes(selected.kind)
    ? layerListFor(selected.kind)[0].find((l) => l.id === selected.id)
    : null;
  const isEditingSelectedCrop = !!(selectedLayer && cropEditing?.kind === selected.kind && cropEditing.id === selected.id);

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)} style={fullscreen ? { padding: 0 } : undefined}>
      <div
        className="modal-card modal-card-lg"
        style={fullscreen
          ? { maxWidth: 'none', width: '100vw', height: '100vh', padding: 0, borderRadius: 0, display: 'flex', flexDirection: 'column', position: 'relative' }
          : { maxWidth: 900, position: 'relative' }}
      >
        {fullscreen ? (
          // The title bar is dropped entirely in fullscreen so the picture
          // can span the full viewport height (see FULLSCREEN_V_RESERVE) -
          // just the two controls remain, floating over the top-right corner
          // of the picture instead of taking their own layout row.
          <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 30, display: 'flex', gap: 6 }}>
            <button
              className="icon-btn" style={{ width: 30, height: 30, background: 'rgba(20,20,20,0.75)' }} onClick={() => setFullscreen(false)}
              title={L.poster_collapseFullscreen}
            >
              <Minimize2 size={15} />
            </button>
            <button className="icon-btn" style={{ width: 30, height: 30, background: 'rgba(20,20,20,0.75)' }} onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        ) : (
          <div className="modal-header">
            <span>{L.poster_constructorTitle}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setFullscreen(true)}
                title={L.poster_expandFullscreen}
              >
                <Maximize2 size={15} />
              </button>
              <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
                <X size={15} />
              </button>
            </div>
          </div>
        )}

        <div style={fullscreen ? { display: 'flex', gap: 16, flex: 1, minHeight: 0, padding: '0 14px 14px' } : { display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {fullscreen ? (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {pictureBox}
            </div>
          ) : pictureBox}

          <div style={panelStyle}>
            {bg.image && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={undo} disabled={past.length === 0} title={L.poster_undo}>
                  <Undo2 size={13} />
                </button>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={redo} disabled={future.length === 0} title={L.poster_redo}>
                  <Redo2 size={13} />
                </button>
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.15)' }} />
                <span className="scene-prompt-label" style={{ flex: 1 }}>{L.poster_zoomLabel}</span>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => zoomButton(1 / ZOOM_STEP)} title={L.poster_zoomOut}>
                  <Minus size={13} />
                </button>
                <button className="icon-btn" style={{ width: 44, height: 26, fontSize: 10.5 }} onClick={resetZoom} title={L.poster_zoomReset}>
                  {Math.round(zoom * 100)}%
                </button>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => zoomButton(ZOOM_STEP)} title={L.poster_zoomIn}>
                  <Plus size={13} />
                </button>
              </div>
            )}

            <PickerRow label={L.poster_backgroundLabel} scrollable collapsible>
              {candidates.map((path) => (
                <PickerThumb key={path} selected={backgroundPath === path} onClick={() => pickBackground(path)}>
                  <img src={mediaUrl(`projects/${projectId}/${path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_titleCardLabel} collapsible>
              {variants.map((v) => (
                <PickerThumb key={v.variant_id} selected={titleCardVariantId === v.variant_id} onClick={() => pickTitleCard(v.variant_id)}>
                  <img src={mediaUrl(`projects/${projectId}/${v.file_path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <MagicLayersPanel
              L={L} projectId={projectId}
              groups={magicLayerGroups}
              backgroundPath={backgroundPath}
              titleCardPath={titleVariant?.file_path || null}
              activeGroupId={magicLayers[0]?.src?.group_id || null}
              busySources={magicBusySources}
              disabled={!bg.width}
              onDecompose={onDecomposeMagicLayers}
              onApply={applyMagicGroup}
              onClear={clearMagicLayers}
              onDeleteGroup={onDeleteMagicLayerGroup}
            />

            <PickerRow label={L.poster_logoLabel} collapsible defaultOpen={false}>
              <PickerThumb selected={!logoId} onClick={() => pickLogo(null)}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 10.5, color: 'var(--text-dim)' }}>
                  {L.poster_noLogo}
                </span>
              </PickerThumb>
              {logos.map((l) => (
                <PickerThumb key={l.id} selected={logoId === l.id} onClick={() => pickLogo(l.id)} title={l.name}>
                  <img src={mediaUrl(l.file_path)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_objectsLabel} collapsible defaultOpen={false}>
              {glassLayer ? (
                <PickerThumb selected={selected?.kind === 'glass'} onClick={() => setSelected({ kind: 'glass' })} title={L.poster_glassLabel}>
                  <div style={{ width: '100%', height: '100%', borderRadius: 5, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.5)' }} />
                </PickerThumb>
              ) : (
                <button className="btn" style={{ fontSize: 12, padding: '6px 10px', gap: 6 }} onClick={addGlass} disabled={!bg.width}>
                  <Square size={13} />
                  {L.poster_addGlass}
                </button>
              )}
              {textLayers.map((layer) => (
                <PickerThumb
                  key={layer.id} selected={selected?.kind === 'text' && selected.id === layer.id}
                  onClick={() => setSelected({ kind: 'text', id: layer.id })} title={layer.text}
                >
                  <span
                    style={{
                      fontFamily: layer.fontFamily, fontSize: 15, color: '#fff', fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
                      background: layer.textType === 'badge' ? '#000' : 'transparent', borderRadius: 5,
                      textShadow: layer.textType === 'halo' ? '0 0 4px rgba(0,0,0,0.6)' : 'none',
                    }}
                  >
                    Aa
                  </span>
                </PickerThumb>
              ))}
              <button className="btn" style={{ fontSize: 12, padding: '6px 10px', gap: 6 }} onClick={() => addTextLayer('badge')} disabled={!bg.width}>
                <Type size={13} />
                {L.poster_addTextBadge}
              </button>
              <button className="btn" style={{ fontSize: 12, padding: '6px 10px', gap: 6 }} onClick={() => addTextLayer('halo')} disabled={!bg.width}>
                <Type size={13} />
                {L.poster_addTextHalo}
              </button>
            </PickerRow>

            <PickerRow label={L.poster_templatesLabel} collapsible defaultOpen={false}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                {posterTemplates.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {posterTemplates.map((t) => (
                      <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <button className="chip" onClick={() => applyTemplate(t.id)} title={L.poster_applyTemplate}>{t.name}</button>
                        <button
                          className="icon-btn" style={{ width: 20, height: 20 }}
                          title={L.poster_deleteTemplate}
                          onClick={() => onDeleteTemplate?.(t.id)}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="field" style={{ flex: 1, fontSize: 12 }}
                    value={templateNameDraft}
                    onChange={(e) => setTemplateNameDraft(e.target.value)}
                    placeholder={L.poster_templateNamePlaceholder}
                  />
                  <button
                    className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5, flexShrink: 0 }}
                    onClick={saveCurrentAsTemplate} disabled={!templateNameDraft.trim()}
                  >
                    <Save size={12} />
                    {L.poster_saveTemplate}
                  </button>
                </div>
              </div>
            </PickerRow>

            <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{L.poster_dragHint}</div>

            {selected?.kind === 'glass' && glassLayer && (
              <GlassPanel glass={glassLayer} onChange={(next) => commit(() => setGlassLayer(next))} onRemove={removeGlass} L={L} />
            )}

            {selectedLayer && (
              <>
                <LayerToolbar
                  layer={selectedLayer}
                  siblingCount={layerListFor(selected.kind)[0].length}
                  isCropEditing={isEditingSelectedCrop}
                  allowCrop={selected.kind !== 'text'}
                  alwaysDeletable={selected.kind === 'text' || selected.kind === 'magic'}
                  onDuplicate={() => duplicateLayer(selected.kind, selected.id)}
                  onDelete={() => deleteLayer(selected.kind, selected.id)}
                  onToggleCrop={() => setCropEditing(isEditingSelectedCrop ? null : { kind: selected.kind, id: selected.id })}
                  onResetCrop={() => updateLayer(selected.kind, selected.id, { crop: null })}
                  onMoveBack={selected.kind === 'magic' ? () => moveMagicLayer(selected.id, -1) : undefined}
                  onMoveFront={selected.kind === 'magic' ? () => moveMagicLayer(selected.id, 1) : undefined}
                  L={L}
                />
                {selected.kind === 'text' && (
                  <TextLayerPanel
                    layer={selectedLayer}
                    defaultFontSize={defaultTextFontSize(selectedLayer.textType, bg.width)}
                    onChange={(patch) => updateLayer('text', selected.id, patch)}
                    L={L}
                  />
                )}
                {!isEditingSelectedCrop && (
                  <EffectsPanel
                    label={selected.kind === 'title'
                      ? L.poster_titleCardLabel
                      : selected.kind === 'logo'
                        ? L.poster_logoLabel
                        : selected.kind === 'magic'
                          ? (selectedLayer.src?.is_background ? L.magic_backgroundLayer : `${L.magic_layer} ${selectedLayer.src?.index ?? ''}`)
                          : (selectedLayer.textType === 'badge' ? L.poster_textBadgeLabel : L.poster_textHaloLabel)}
                    effects={selectedLayer.effects}
                    onChange={(next) => updateLayer(selected.kind, selected.id, { effects: next })}
                    L={L}
                  />
                )}
              </>
            )}

            <button
              className="btn btn-gradient" style={{ justifyContent: 'center', padding: 11, marginTop: 'auto' }}
              disabled={saving || !backgroundPath || !titleCardVariantId}
              onClick={handleSave}
            >
              <Save size={14} />
              {saving ? L.poster_saving : L.poster_save}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

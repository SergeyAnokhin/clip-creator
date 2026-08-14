import { useState } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ChevronDown, ChevronUp, Copy, Crop, RotateCcw, Trash2,
} from 'lucide-react';
import { FONT_OPTIONS } from '../../lib/posterLayers.js';

/** The Poster constructor's side-panel widgets: per-layer effects
 * (opacity/glow/clone), the layer toolbar, the glass-panel and text-layer
 * property panels, and the collapsible picker rows. All controlled - they
 * render props and call back, holding no poster state of their own.
 */

export function ResetToDefault({ onClick, L }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={L.poster_resetToDefault}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 16, height: 16, padding: 0, border: 'none', borderRadius: 4,
        background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', flexShrink: 0,
      }}
    >
      <RotateCcw size={11} />
    </button>
  );
}

export function EffectSlider({ label, value, min, max, step = 1, unit = '', defaultValue, onChange, L }) {
  const canReset = defaultValue !== undefined && value !== defaultValue;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
      <span style={{ color: 'var(--text-dim)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span>{value}{unit}</span>
          {canReset && <ResetToDefault onClick={() => onChange(defaultValue)} L={L} />}
        </span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#ff9d5c' }}
      />
    </label>
  );
}

export function ColorField({ label, value, defaultValue, onChange, L }) {
  const canReset = defaultValue !== undefined && value !== defaultValue;
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-dim)' }}>
      <span style={{ flex: 1 }}>{label}</span>
      {canReset && <ResetToDefault onClick={() => onChange(defaultValue)} L={L} />}
      <input
        type="color" value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: 28, height: 22, padding: 0, border: 'none', borderRadius: 4, background: 'none', cursor: 'pointer' }}
      />
    </label>
  );
}

/** Property controls for the currently selected overlay layer (title card
 * or logo): the layer's own opacity, plus an optional glow (shadow cast by
 * the image's own alpha shape - color/blur/distance/intensity). Mirrors
 * Canva's shadow-effect controls, which is what glow was modeled after. */
export function EffectsPanel({ label, effects, onChange, L }) {
  const { glow, clone } = effects;
  const opacity = effects.opacity ?? 1;
  const patchGlow = (p) => onChange({ ...effects, glow: { ...glow, ...p } });
  const patchClone = (p) => onChange({ ...effects, clone: { ...clone, ...p } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div className="scene-prompt-label">{label}</div>

      <EffectSlider
        label={L.poster_effect_opacity} value={Math.round(opacity * 100)} min={5} max={100} unit="%"
        defaultValue={100} L={L}
        onChange={(v) => onChange({ ...effects, opacity: v / 100 })}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={glow.enabled} onChange={(e) => patchGlow({ enabled: e.target.checked })} />
          {L.poster_effect_glow}
        </label>
        {glow.enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20 }}>
            <ColorField
              label={L.poster_effect_color} value={glow.color} defaultValue="#000000" L={L}
              onChange={(v) => patchGlow({ color: v })}
            />
            <EffectSlider
              label={L.poster_effect_blur} value={glow.blur} min={0} max={250} defaultValue={0} L={L}
              onChange={(v) => patchGlow({ blur: v })}
            />
            <EffectSlider
              label={L.poster_effect_distance} value={glow.distance} min={0} max={200} defaultValue={0} L={L}
              onChange={(v) => patchGlow({ distance: v })}
            />
            <EffectSlider
              label={L.poster_effect_intensity} value={Math.round((glow.opacity / 5) * 100)} min={0} max={100} unit="%"
              defaultValue={0} L={L}
              onChange={(v) => patchGlow({ opacity: (v / 100) * 5 })}
            />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={clone.enabled} onChange={(e) => patchClone({ enabled: e.target.checked })} />
          {L.poster_effect_clone}
        </label>
        {clone.enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20 }}>
            <EffectSlider label={L.poster_effect_cloneOffsetX} value={clone.offsetX} min={-100} max={100} unit="px" onChange={(v) => patchClone({ offsetX: v })} />
            <EffectSlider label={L.poster_effect_cloneOffsetY} value={clone.offsetY} min={-100} max={100} unit="px" onChange={(v) => patchClone({ offsetY: v })} />
            <EffectSlider
              label={L.poster_effect_cloneOpacity} value={Math.round(clone.opacity * 100)} min={5} max={100} unit="%"
              onChange={(v) => patchClone({ opacity: v / 100 })}
            />
            <EffectSlider label={L.poster_effect_cloneBlur} value={clone.blur} min={0} max={40} onChange={(v) => patchClone({ blur: v })} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Duplicate/crop/delete toolbar for the selected title/logo/text layer -
 * duplicate clones the layer (offset slightly, independently movable from
 * then on); crop toggles OverlayImage's crop-editing mode; delete normally
 * only shows once there's more than one layer of that kind, so the last
 * remaining title/logo layer can't be deleted into an empty (and then
 * auto-refilled - see PosterConstructor's default-placement effects) state
 * via this button. Text layers have no such auto-refill (a poster can
 * legitimately have zero text layers), so `alwaysDeletable` skips that gate
 * for them - otherwise a poster's only badge/halo layer could never be
 * removed. */
export function LayerToolbar({ layer, siblingCount, isCropEditing, allowCrop = true, alwaysDeletable = false, onDuplicate, onDelete, onToggleCrop, onResetCrop, L }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {!isCropEditing && (
        <button className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5 }} onClick={onDuplicate}>
          <Copy size={12} />
          {L.poster_duplicate}
        </button>
      )}
      {allowCrop && (
        <button className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5 }} onClick={onToggleCrop}>
          <Crop size={12} />
          {isCropEditing ? L.poster_cropDone : L.poster_crop}
        </button>
      )}
      {allowCrop && layer.crop && !isCropEditing && (
        <button className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5 }} onClick={onResetCrop}>
          <RotateCcw size={12} />
          {L.poster_cropReset}
        </button>
      )}
      {(siblingCount > 1 || alwaysDeletable) && !isCropEditing && (
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onDelete} title={L.poster_deleteLayer}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/** Property controls for the glass panel object: opacity, "thickness"
 * (drives edge-highlight strength and drop shadow, both in OverlayGlass's
 * live preview and in the real blurred version baked in at save), and
 * corner radius. */
export function GlassPanel({ glass, onChange, onRemove, L }) {
  const maxCorner = Math.round(Math.min(glass.width * glass.scaleX, glass.height * glass.scaleY) / 2);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="scene-prompt-label">{L.poster_glassLabel}</div>
        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={onRemove} title={L.poster_glassRemove}>
          <Trash2 size={12} />
        </button>
      </div>
      <EffectSlider
        label={L.poster_glassOpacity} value={Math.round(glass.opacity * 100)} min={5} max={90} unit="%"
        onChange={(v) => onChange({ ...glass, opacity: v / 100 })}
      />
      <EffectSlider
        label={L.poster_glassThickness} value={glass.thickness} min={0} max={100}
        onChange={(v) => onChange({ ...glass, thickness: v })}
      />
      <EffectSlider
        label={L.poster_glassCorner} value={Math.round(glass.cornerRadius)} min={0} max={maxCorner}
        onChange={(v) => onChange({ ...glass, cornerRadius: v })}
      />
    </div>
  );
}

/** Content/typography controls for the selected text layer (badge or
 * halo) - text content, font family (`FONT_OPTIONS`), size, and text
 * color, plus the pill color when the layer is a badge. The shared
 * opacity/glow controls stay in `EffectsPanel`, rendered separately right
 * after this panel - this one only owns the text-specific fields. */
export function TextLayerPanel({ layer, defaultFontSize, onChange, L }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div className="scene-prompt-label">{layer.textType === 'badge' ? L.poster_textBadgeLabel : L.poster_textHaloLabel}</div>
      <textarea
        value={layer.text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={2}
        style={{
          width: '100%', resize: 'vertical', fontSize: 12, padding: 6, borderRadius: 6,
          background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-dim)' }}>
        {L.poster_textAlignLabel}
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { value: 'left', Icon: AlignLeft, title: L.poster_alignLeft },
            { value: 'center', Icon: AlignCenter, title: L.poster_alignCenter },
            { value: 'right', Icon: AlignRight, title: L.poster_alignRight },
          ].map(({ value, Icon, title }) => (
            <button
              key={value}
              className="icon-btn"
              style={{
                width: 28, height: 26,
                background: (layer.align || 'left') === value ? 'rgba(255,157,92,0.25)' : undefined,
                border: (layer.align || 'left') === value ? '1px solid #ff9d5c' : undefined,
              }}
              title={title}
              onClick={() => onChange({ align: value })}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-dim)' }}>
        {L.poster_fontLabel}
        <select
          value={layer.fontFamily}
          onChange={(e) => onChange({ fontFamily: e.target.value })}
          style={{ padding: 6, borderRadius: 6, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff' }}
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value} style={{ color: '#000' }}>{f.label}</option>
          ))}
        </select>
      </label>
      <EffectSlider
        label={L.poster_fontSizeLabel} value={layer.fontSize} min={10} max={400}
        defaultValue={defaultFontSize} L={L}
        onChange={(v) => onChange({ fontSize: v })}
      />
      <ColorField label={L.poster_textColorLabel} value={layer.color} onChange={(v) => onChange({ color: v })} />
      {layer.textType === 'badge' && (
        <ColorField label={L.poster_badgeColorLabel} value={layer.bgColor} onChange={(v) => onChange({ bgColor: v })} />
      )}
    </div>
  );
}

/** One picker section (background/title card/logo/objects) in the side
 * panel. `collapsible` lets the user fold sections they're done with to
 * keep the fixed-width panel compact - collapse state is local (not lifted
 * to PosterConstructor) since nothing outside this row needs it. */
export function PickerRow({ label, children, scrollable, collapsible, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = !collapsible || open;
  return (
    <div>
      <div
        className="scene-prompt-label"
        style={{
          marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: collapsible ? 'pointer' : 'default',
        }}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
      >
        <span>{label}</span>
        {collapsible && (open ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
      </div>
      {isOpen && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...(scrollable ? { maxHeight: 140, overflowY: 'auto' } : {}) }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function PickerThumb({ selected, onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: 0, borderRadius: 6, width: 56, height: 56, flexShrink: 0, cursor: 'pointer',
        background: 'rgba(255,255,255,0.04)',
        border: selected ? '2px solid #ff9d5c' : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {children}
    </button>
  );
}

/** Composites a background (a scene/reference image already generated in an
 * earlier stage) with a title-card overlay and an optional logo, positioned
 * and scaled by dragging Konva Transformer handles - the actual "afisha"
 * (poster), as opposed to the Title Card stage's "Generate title" button
 * which only produces the typographic overlay itself. Saving flattens the
 * Konva stage to a PNG client-side (no server-side image compositing
 * dependency needed) and uploads it alongside the layer transforms, so
 * `onEdit` can reopen this exact same arrangement later. */

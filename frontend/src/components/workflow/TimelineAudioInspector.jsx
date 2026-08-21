import { Volume2 } from 'lucide-react';
import { EffectSlider } from './PosterPanels.jsx';

/** Properties strip for the audio row - shown when the waveform track itself
 * is the selected object (`isAudioSelected`, see `useEditorStage.js`'s
 * `selectAudio`). Everything here maps 1:1 onto `video_edit.audio`, which
 * `providers/editor.py` turns into the render's own `volume`/`afade`/`atrim`
 * audio chain:
 *
 * - **volume** - a flat gain over the whole track.
 * - **fade in / fade out** - ramps at the very start and the very end of the
 *   *output*, not of the source file, so a fade-out always lands on the last
 *   frame of the video regardless of how the clips were trimmed.
 * - **offset** - how much of the track's own head to skip, i.e. "start the
 *   song from its chorus". The in-browser preview mirrors it
 *   (`useEditorPreview.js`), so the playhead means the same moment in both.
 *
 * Volume and fades are the two controls CapCut/Movavi put on every audio
 * clip; this stage has exactly one audio track, so they live on the track
 * rather than per-clip. */
export default function TimelineAudioInspector({
  L, track, audio, actions,
}) {
  if (!track) {
    return <div className="tl-inspector tl-inspector-empty">{L.editor_noAudioTrack}</div>;
  }

  const durationMs = track.duration_ms || 0;

  return (
    <div className="tl-inspector">
      <span className="tl-inspector-title">
        <Volume2 size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
        {L.editor_audioInspectorTitle}
      </span>
      <span className="tl-overlay-inspector-label tl-inspector-row">
        {(track.file_path || '').split('/').pop()}
      </span>

      <div className="tl-inspector-row" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <EffectSlider
          label={L.editor_audioVolumeLabel} value={Math.round(audio.volume * 100)} min={0} max={200}
          unit="%" onChange={(v) => actions.setAudioSettings({ volume: v / 100 })} L={L}
        />
      </div>

      <span className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.editor_fadeInLabel}</span>
        <input
          type="number" step="0.1" min={0}
          className="field tl-inspector-num" value={(audio.fade_in_ms / 1000).toFixed(1)}
          aria-label={L.editor_fadeInLabel}
          onChange={(e) => actions.setAudioSettings({ fade_in_ms: Math.max(0, Number(e.target.value)) * 1000 })}
        />
        <span className="tl-inspector-rowlabel">{L.editor_fadeOutLabel}</span>
        <input
          type="number" step="0.1" min={0}
          className="field tl-inspector-num" value={(audio.fade_out_ms / 1000).toFixed(1)}
          aria-label={L.editor_fadeOutLabel}
          onChange={(e) => actions.setAudioSettings({ fade_out_ms: Math.max(0, Number(e.target.value)) * 1000 })}
        />
      </span>

      <span className="tl-inspector-label tl-inspector-row">
        <span className="tl-inspector-rowlabel">{L.editor_audioOffsetLabel}</span>
        <input
          type="number" step="0.1" min={0} {...(durationMs > 0 ? { max: (durationMs / 1000).toFixed(1) } : {})}
          className="field tl-inspector-num" value={(audio.offset_ms / 1000).toFixed(1)}
          aria-label={L.editor_audioOffsetLabel}
          onChange={(e) => actions.setAudioSettings({
            offset_ms: Math.max(0, Math.min(durationMs, Number(e.target.value) * 1000)),
          })}
        />
      </span>
      <span className="tl-hint tl-inspector-row">{L.editor_audioOffsetHint}</span>
    </div>
  );
}

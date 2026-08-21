"""EDL -> render plan for the Editor stage: resolving, validating and
clamping everything `video_edit` holds (clips, trims, speed, fit, colour
adjust, freeze, overlays, transitions, fades, audio, export settings) into
the flat plan dict `editor_ffmpeg.build_ffmpeg_command` turns into an actual
command. Pure except for the optional `ffprobe` fallback and text-overlay
rasterization, both of which only happen when a `project_dir` is passed.

Subsystem overview lives in `editor.py`'s own docstring."""

import hashlib
import math
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from .. import storage

# Output canvas: a fixed size keeps the ffmpeg filter graph simple regardless
# of what resolution/aspect ratio each source clip was generated at - every
# clip is scaled into the same frame, by default cropping overflow to fill it
# (`clip.fit`, see this module's own docstring), letterboxed only when a clip
# explicitly opts into `contain`. Auto mode (`video_edit.canvas_orientation`
# absent or `'auto'`) picks '9:16' unless some clip's own stored
# `aspect_ratio` is *explicitly* something else - an unset/unprobed
# `aspect_ratio` (a manually uploaded clip - see `build_render_plan`'s own
# comment) doesn't force landscape, only a known non-9:16 clip does.
# `'portrait'`/`'landscape'` force that canvas outright regardless of any
# clip's aspect ratio - the manual override a user picks when auto-detection
# guesses wrong.
_DEFAULT_CANVAS = (1920, 1080)
_PORTRAIT_CANVAS = (1080, 1920)
_FPS = 30

_DEFAULT_FIT = {'mode': 'cover', 'zoom': 1.0, 'offset_x_pct': 50.0, 'offset_y_pct': 50.0}
_MIN_FIT_ZOOM = 1.0
_MAX_FIT_ZOOM = 4.0

_OVERLAY_DEFAULT_WIDTH_PCT = 20.0

# `position` (a 9-point anchor - pins the overlay's own matching corner/edge/
# center to that point, e.g. "bottom-right" pins its own bottom-right corner
# there) -> `[xPct, yPct]` of the canvas. Kept only for `_migrate_overlay_
# position` below, which converts an old-shape overlay to the current
# `x_pct`/`y_pct` (top-left-anchored) fields the first time it's resolved -
# exact Python mirror of `lib/overlays.js`'s private `_LEGACY_POSITION_PCT`.
_LEGACY_POSITION_PCT = {
    'top-left': (0, 0), 'top-center': (50, 0), 'top-right': (100, 0),
    'center-left': (0, 50), 'center': (50, 50), 'center-right': (100, 50),
    'bottom-left': (0, 100), 'bottom-center': (50, 100), 'bottom-right': (100, 100),
}
_LEGACY_DEFAULT_POSITION = 'bottom-right'

# User-facing transition `type` -> ffmpeg `xfade` filter's own transition
# name. A deliberately small, curated set (not xfade's full catalogue of
# wipes/slides/etc.) - "dissolve" is a plain crossfade, "fadeblack"/
# "fadewhite" blend through a solid colour (the "переход через чёрный" /
# "вспышка" the feature was asked for).
_TRANSITION_XFADE_NAME = {
    'dissolve': 'fade', 'fadeblack': 'fadeblack', 'fadewhite': 'fadewhite',
    'wipeleft': 'wipeleft', 'wiperight': 'wiperight', 'wipeup': 'wipeup', 'wipedown': 'wipedown',
    'slideleft': 'slideleft', 'slideright': 'slideright', 'slideup': 'slideup', 'slidedown': 'slidedown',
    'circleopen': 'circleopen', 'circleclose': 'circleclose', 'radial': 'radial', 'pixelize': 'pixelize',
}
_TRANSITION_MIN_S = 0.05
_FADE_COLORS = {'black', 'white'}

# `video_edit.audio` defaults - absent/`None` means exactly these, which is
# also what this module did before the field existed (whole track, full
# volume, from its very start), so no saved project needs migrating.
_DEFAULT_AUDIO = {'volume': 1.0, 'fade_in_ms': 0.0, 'fade_out_ms': 0.0, 'offset_ms': 0.0}
_MAX_AUDIO_VOLUME = 4.0

# `clip.adjust` defaults - ffmpeg `eq` semantics. A clip whose adjust equals
# these (or is absent) gets no `eq` filter at all, so an untouched project's
# filter graph is byte-for-byte what it was before colour correction existed.
_DEFAULT_ADJUST = {'brightness': 0.0, 'contrast': 1.0, 'saturation': 1.0, 'gamma': 1.0}

# `video_edit.export` - output pixels/frames/encoder effort, independent of
# `canvas_orientation` (which only picks portrait vs landscape). `'source'`
# keeps whatever canvas the orientation heuristic resolved.
_EXPORT_SHORT_SIDE = {'720p': 720, '1080p': 1080, '4k': 2160}
_EXPORT_FPS_OPTIONS = (24, 30, 60)
# (crf, x264 preset) per quality tier - crf is the real quality knob, the
# preset trades encode time for file size at the same quality.
_EXPORT_QUALITY = {
    'high': (18, 'medium'),
    'medium': (23, 'medium'),
    'low': (28, 'veryfast'),
}
_DEFAULT_EXPORT = {'resolution': 'source', 'fps': _FPS, 'quality': 'high'}

# `kind: 'text'` overlay fonts - the EDL stores a family name (the same one
# the browser's Konva `Text` node draws with, see `lib/overlays.js`'s
# `TEXT_FONTS`), and this maps it to an actual font file to rasterize with.
# The candidates are tried in order, so a non-Windows host falls back to a
# DejaVu face (also Cyrillic-capable) rather than failing the render; if none
# of them exist, `_resolve_font` falls back to Pillow's built-in bitmap font,
# which is ugly but never raises.
_TEXT_FONT_FILES = {
    'Arial': ('arial.ttf', 'Arial.ttf', 'DejaVuSans.ttf'),
    'Segoe UI': ('segoeui.ttf', 'DejaVuSans.ttf'),
    'Times New Roman': ('times.ttf', 'Times New Roman.ttf', 'DejaVuSerif.ttf'),
    'Georgia': ('georgia.ttf', 'DejaVuSerif.ttf'),
    'Verdana': ('verdana.ttf', 'DejaVuSans.ttf'),
    'Trebuchet MS': ('trebuc.ttf', 'DejaVuSans.ttf'),
    'Impact': ('impact.ttf', 'DejaVuSans-Bold.ttf'),
    'Courier New': ('cour.ttf', 'DejaVuSansMono.ttf'),
}
_TEXT_FONT_DIRS = (
    Path('C:/Windows/Fonts'),
    Path('/usr/share/fonts/truetype/dejavu'),
    Path('/usr/share/fonts'),
    Path('/Library/Fonts'),
)
# Point size the text is rasterized at before the overlay's own
# `width_pct`/`height_pct` scale it onto the canvas - mirrors
# `lib/overlays.js`'s `TEXT_RASTER_FONT_SIZE`, which is what the live preview
# measures with, so both sides agree on the block's aspect ratio.
_TEXT_RASTER_FONT_SIZE = 160
_DEFAULT_TEXT = {
    'content': '', 'font': 'Arial', 'color': '#ffffff',
    'outline_color': '#000000', 'outline_width': 4, 'align': 'center', 'line_spacing': 1.2,
}

# `_resolve_audio`'s output for the all-defaults case - what a plan dict
# assembled by hand (or by an older version of this module) falls back to.
_DEFAULT_AUDIO_RESOLVED = {'volume': 1.0, 'fade_in_s': 0.0, 'fade_out_s': 0.0, 'offset_s': 0.0}


class RenderPlanError(ValueError):
    """Raised by `build_render_plan` for an EDL that can't be resolved
    against the project's actual scenes/tracks - a 422 at the router."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _resolve_clip_video(project: dict, scene_index: int, video_id: str) -> dict:
    scenes = project.get('scenes') or []
    if scene_index < 0 or scene_index >= len(scenes):
        raise RenderPlanError(f'Сцена {scene_index} не найдена')
    videos = scenes[scene_index].get('videos') or []
    video = next((v for v in videos if v.get('video_id') == video_id), None)
    if video is None:
        raise RenderPlanError(f'Видео {video_id} не найдено в сцене {scene_index}')
    return video


def _probe_duration_ms(path: Path) -> float | None:
    """Best-effort real file duration via `ffprobe`, in ms - `None` on any
    failure (`ffprobe`/the file missing, a non-numeric or empty result,
    `ffprobe` erroring on a corrupt file). Only ever called as a fallback for
    a clip whose `Video.duration_seconds` is unknown (a manually uploaded/
    imported clip - see `build_render_plan`'s docstring), so a probe failure
    just leaves that clip unbounded exactly like before this existed -
    never raises, never blocks a render on a probe going wrong."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
            capture_output=True, check=False,
        )
        if result.returncode != 0:
            return None
        return float(result.stdout.decode(errors='replace').strip()) * 1000
    except (OSError, ValueError):
        return None


def _resolve_track(project: dict, track_id: str) -> dict:
    tracks = (project.get('mureka') or {}).get('tracks') or []
    track = next((t for t in tracks if t.get('track_id') == track_id), None)
    if track is None:
        raise RenderPlanError(f'Аудиотрек {track_id} не найден')
    return track


def _resolve_overlay_source(
    project: dict, settings: dict, video_edit: dict, overlay: dict, project_dir: Path | None = None,
) -> str:
    """The overlay source's `file_path` - project-relative for a title card
    variant or a video-overlay source (both live under this project's own
    directory, joined against `project_dir` in `build_ffmpeg_command`, same
    convention as a clip's own `file_path`), or an *absolute* path for a logo
    (the global cross-project library lives under the data root, not any
    project's own directory). `project_dir / file_path` silently prefers an
    absolute right-hand operand (pathlib), so `build_ffmpeg_command` never has
    to special-case which base a given overlay resolves against - it just
    always joins against `project_dir`."""
    kind = overlay.get('kind')
    source_id = overlay.get('source_id')
    if kind == 'text':
        # The only kind with no stored source file: it is rasterized from the
        # overlay's own `text` block into a content-addressed cache under the
        # project. The path is derived purely (so `build_render_plan` still
        # works with no `project_dir` - the pure mode the tests use); the file
        # is only actually written when a real render passes one in.
        text = _resolve_text(overlay.get('text'))
        file_path = _text_overlay_file_path(text)
        if project_dir is not None:
            dest = project_dir / file_path
            if not dest.exists():
                _render_text_png(text, dest)
        return file_path
    if kind == 'title_card':
        variants = (project.get('title_card') or {}).get('variants') or []
        variant = next((v for v in variants if v.get('variant_id') == source_id), None)
        if variant is None:
            raise RenderPlanError(f'Оверлей: вариант заголовка {source_id} не найден')
        return variant['file_path']
    if kind == 'logo':
        logos = settings.get('logos') or []
        logo = next((item for item in logos if item.get('id') == source_id), None)
        if logo is None:
            raise RenderPlanError(f'Оверлей: логотип {source_id} не найден')
        return str(storage.get_data_root() / logo['file_path'])
    if kind == 'video':
        sources = video_edit.get('overlay_video_sources') or []
        source = next((item for item in sources if item.get('id') == source_id), None)
        if source is None:
            raise RenderPlanError(f'Оверлей: видео {source_id} не найдено')
        return source['file_path']
    raise RenderPlanError(f'Оверлей: неизвестный тип {kind!r}')


def _resolve_font(family: str):
    """A Pillow font object for one of `_TEXT_FONT_FILES`' family names, at
    `_TEXT_RASTER_FONT_SIZE`. Falls back through that family's candidate file
    names across `_TEXT_FONT_DIRS` and finally to Pillow's built-in bitmap
    font - a text overlay must never be the reason a render fails, and a
    wrong-looking face is a far better outcome than no video."""
    from PIL import ImageFont  # noqa: PLC0415 - optional-at-import-time, see module docstring

    for name in _TEXT_FONT_FILES.get(family, ()) or (family,):
        for directory in _TEXT_FONT_DIRS:
            candidate = directory / name
            if candidate.exists():
                try:
                    return ImageFont.truetype(str(candidate), _TEXT_RASTER_FONT_SIZE)
                except OSError:
                    continue
    try:
        return ImageFont.truetype(_TEXT_FONT_FILES['Arial'][-1], _TEXT_RASTER_FONT_SIZE)
    except OSError:
        return ImageFont.load_default()


def _resolve_text(raw: dict | None) -> dict:
    """`kind: 'text'` overlay's own styling block, defaults filled in."""
    text = {**_DEFAULT_TEXT, **(raw or {})}
    text['content'] = str(text.get('content') or '')
    if text.get('align') not in ('left', 'center', 'right'):
        text['align'] = 'center'
    text['outline_width'] = max(0, int(text.get('outline_width') or 0))
    try:
        text['line_spacing'] = max(0.5, float(text.get('line_spacing') or 1.2))
    except (TypeError, ValueError):
        text['line_spacing'] = 1.2
    return text


def _text_overlay_file_path(text: dict) -> str:
    """Project-relative path of the PNG a given text+style rasterizes to.
    Content-addressed (sha1 of the styling block), so editing the text writes
    a new file and re-rendering an unchanged overlay reuses the cached one
    instead of redrawing it - and so this stays a *pure* function that
    `build_render_plan` can resolve without a `project_dir` (the pure/test
    mode every existing test uses)."""
    key = '|'.join(str(text[field]) for field in sorted(_DEFAULT_TEXT))
    digest = hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]
    return f'editor/text_cache/{digest}.png'


def _render_text_png(text: dict, dest: Path) -> None:
    """Draws one text overlay to a transparent PNG at `dest`.

    Text is deliberately *not* a new ffmpeg filter: `drawtext` needs a
    fontfile path escaped for the filtergraph (a minefield on Windows, where
    the path contains a drive colon), plus its own escaping for the text
    itself - quotes, colons, newlines and Cyrillic all in play. Rasterizing
    here instead means a text overlay reuses the *existing* image-overlay
    compositing path in `build_ffmpeg_command` byte for byte, so it inherits
    placement, rotation, opacity and fades for free and adds no new failure
    mode to the filter graph.

    `stroke_width` gives the outline that keeps white text readable over
    bright footage, and is drawn by Pillow *around* the glyphs, so the image
    is padded by it on every side. This mirrors what the preview's Konva
    `Text` node draws with `stroke`/`strokeWidth`."""
    from PIL import Image, ImageDraw  # noqa: PLC0415

    font = _resolve_font(text['font'])
    content = text['content'] or ' '
    stroke = text['outline_width']
    spacing = int(_TEXT_RASTER_FONT_SIZE * (text['line_spacing'] - 1))

    # Measure on a throwaway 1x1 canvas first - Pillow has no "how big would
    # this be" call that accounts for stroke and multi-line spacing other
    # than asking a real ImageDraw for the bounding box.
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    left, top, right, bottom = probe.multiline_textbbox(
        (0, 0), content, font=font, spacing=spacing, align=text['align'], stroke_width=stroke,
    )
    width = max(1, math.ceil(right - left) + stroke * 2)
    height = max(1, math.ceil(bottom - top) + stroke * 2)

    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.multiline_text(
        (stroke - left, stroke - top), content, font=font, spacing=spacing, align=text['align'],
        fill=text['color'], stroke_width=stroke, stroke_fill=text['outline_color'],
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)


def _migrate_overlay_position(overlay: dict, canvas_width: int, canvas_height: int) -> dict:
    """An overlay already carrying `x_pct`/`y_pct` *and* `height_axis: 'width'`
    passes through unchanged; anything older gets normalized - exact mirror of
    `lib/overlays.js`'s `migrateOverlay` (see that function's own docstring).

    `height_axis: 'width'` marks the newer convention where `height_pct`, like
    `width_pct`, is a percentage of the canvas's own *width* (not its height) -
    deliberately the same reference axis for both, so their ratio always
    encodes the overlay's true pixel aspect ratio regardless of which shape
    the canvas itself is (`canvas_orientation` can switch between a 9:16
    portrait and 16:9 landscape canvas after an overlay was already placed;
    two percentages measured against two *different* axes don't survive that
    switch undistorted, which is exactly the "logo comes out squished/
    stretched" bug this fixes). An overlay saved before this convention
    existed has `height_pct` as a percentage of canvas *height* instead -
    converted here by rescaling with `canvas_height/canvas_width` so its real
    pixel size (and therefore its real aspect ratio) doesn't jump the first
    time it's re-resolved.

    An old-shape overlay (`position` + bare `width_pct`, no `height_pct`/
    `rotation_deg` at all) gets `x_pct`/`y_pct` derived from the legacy anchor
    and `height_pct == width_pct` - already a square in *pixel* terms once
    both are read as "percentage of canvas width", so it needs no rescaling,
    only the `height_axis` stamp."""
    if overlay.get('x_pct') is not None and overlay.get('y_pct') is not None:
        if overlay.get('height_axis') == 'width':
            return overlay
        height_pct = overlay.get('height_pct') or overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT
        return {
            **overlay,
            'height_pct': height_pct * (canvas_height / canvas_width) if canvas_width > 0 else height_pct,
            'height_axis': 'width',
        }
    anchor_x, anchor_y = _LEGACY_POSITION_PCT.get(overlay.get('position'), _LEGACY_POSITION_PCT[_LEGACY_DEFAULT_POSITION])
    width_pct = overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT
    height_pct = width_pct
    tx_frac = 0.0 if anchor_x == 0 else 1.0 if anchor_x == 100 else 0.5
    ty_frac = 0.0 if anchor_y == 0 else 1.0 if anchor_y == 100 else 0.5
    return {
        **overlay,
        'x_pct': anchor_x - width_pct * tx_frac,
        'y_pct': anchor_y - height_pct * ty_frac,
        'width_pct': width_pct,
        'height_pct': height_pct,
        'rotation_deg': overlay.get('rotation_deg') or 0,
        'height_axis': 'width',
    }


def _resolve_overlays(
    project: dict, settings: dict, video_edit: dict, canvas_width: int, canvas_height: int,
    project_dir: Path | None = None,
) -> list[dict]:
    resolved = []
    for raw_overlay in video_edit.get('overlays') or []:
        overlay = _migrate_overlay_position(raw_overlay, canvas_width, canvas_height)
        file_path = _resolve_overlay_source(project, settings, video_edit, overlay, project_dir)
        duration_ms = overlay.get('duration_ms') or 0
        if duration_ms <= 0:
            raise RenderPlanError('Оверлей: некорректная длительность')
        start_ms = max(0, overlay.get('start_ms') or 0)
        x_pct = float(overlay.get('x_pct') or 0.0)
        y_pct = float(overlay.get('y_pct') or 0.0)
        width_pct = min(100.0, max(1.0, overlay.get('width_pct') or _OVERLAY_DEFAULT_WIDTH_PCT))
        height_pct = min(100.0, max(1.0, overlay.get('height_pct') or width_pct))
        rotation_deg = (overlay.get('rotation_deg') or 0.0) % 360
        opacity = overlay.get('opacity')
        opacity = 1.0 if opacity is None else min(1.0, max(0.0, opacity))
        # Compressed proportionally if they'd together outlast the overlay's
        # own `duration_ms` (so they never overlap past the midpoint) - same
        # clamp `lib/overlays.js`'s `overlayOpacityAt` applies for the live
        # preview, so what the render produces matches what the user saw.
        fade_in_ms = max(0.0, overlay.get('fade_in_ms') or 0.0)
        fade_out_ms = max(0.0, overlay.get('fade_out_ms') or 0.0)
        if fade_in_ms + fade_out_ms > duration_ms:
            scale = duration_ms / (fade_in_ms + fade_out_ms)
            fade_in_ms *= scale
            fade_out_ms *= scale
        resolved.append({
            'kind': overlay.get('kind'),
            'file_path': file_path,
            'start_s': start_ms / 1000,
            'duration_s': duration_ms / 1000,
            'reverse': bool(overlay.get('reverse')),
            'x_pct': x_pct,
            'y_pct': y_pct,
            'width_pct': width_pct,
            'height_pct': height_pct,
            'rotation_deg': rotation_deg,
            'opacity': opacity,
            'fade_in_s': fade_in_ms / 1000,
            'fade_out_s': fade_out_ms / 1000,
        })
    return resolved


def _overlay_alpha_filters(overlay: dict) -> str:
    """The alpha-shaping filter chain fragment for one overlay (comma-joined,
    dropped in right after `format=rgba` in both of `build_ffmpeg_command`'s
    overlay branches): a flat `colorchannelmixer=aa=<opacity>` (today's
    form, unchanged), plus one `fade=...:alpha=1` per fade actually set.
    `colorchannelmixer`'s own `aa` option takes a plain number, not a
    time-varying expression (confirmed against a real ffmpeg build - a
    `t`-based eval expression there fails to parse, `aa` isn't one of the
    filter's expression-capable options) - `fade`'s dedicated `alpha=1` mode
    is the actual supported way to ramp alpha over time. `fade` *multiplies*
    the existing alpha by its own 0->1 (or 1->0) curve during `[st, st+d)`
    and holds flat at the post-ramp value everywhere outside that window
    (1 before a fade-in starts or after a fade-out ends, matching "no
    fade"), so chaining `colorchannelmixer` (sets the flat base) then one
    `fade` per side composes exactly like `lib/overlays.js`'s
    `overlayOpacityAt` computes the same ramp for the live preview. `st`/`d`
    are the overlay's own stream's timestamp in seconds since the whole
    render started - same axis `enable='between(t,...)'` below already uses
    (an image's `-loop 1` stream and a video overlay's `setpts`-shifted
    stream both start counting from that same zero - see this module's own
    docstring and the `pre_filter` comment in `build_ffmpeg_command`)."""
    parts = [f"colorchannelmixer=aa={overlay['opacity']:.3f}"]
    fade_in_s = overlay['fade_in_s']
    fade_out_s = overlay['fade_out_s']
    if fade_in_s > 0:
        parts.append(f"fade=t=in:st={overlay['start_s']:.3f}:d={fade_in_s:.3f}:alpha=1")
    if fade_out_s > 0:
        end_s = overlay['start_s'] + overlay['duration_s']
        fade_out_start = end_s - fade_out_s
        parts.append(f"fade=t=out:st={fade_out_start:.3f}:d={fade_out_s:.3f}:alpha=1")
    return ','.join(parts)


def _resolve_fit(raw: dict | None) -> dict:
    """`{mode, zoom, offset_x_pct, offset_y_pct}` for a `clip.fit` spec -
    `_DEFAULT_FIT` (cover, centered, no extra zoom) when absent. `contain`
    ignores/drops `zoom`/offset (meaningless there - see this module's own
    docstring) rather than carrying stale values through."""
    if not raw or raw.get('mode') != 'contain':
        if not raw:
            return dict(_DEFAULT_FIT)
        return {
            'mode': 'cover',
            'zoom': min(_MAX_FIT_ZOOM, max(_MIN_FIT_ZOOM, raw.get('zoom') or _DEFAULT_FIT['zoom'])),
            'offset_x_pct': min(100.0, max(0.0, raw.get('offset_x_pct') if raw.get('offset_x_pct') is not None else _DEFAULT_FIT['offset_x_pct'])),
            'offset_y_pct': min(100.0, max(0.0, raw.get('offset_y_pct') if raw.get('offset_y_pct') is not None else _DEFAULT_FIT['offset_y_pct'])),
        }
    return {'mode': 'contain'}


def _resolve_fade(raw: dict | None, max_ms: float | None) -> dict | None:
    """`{color, duration_s}` for a `fade_in`/`fade_out` spec, or `None` if
    it's absent/zero-duration. `duration_ms` is clamped to `max_ms` (the
    clip's own resolved content length) - fading longer than the clip itself
    doesn't mean anything. `max_ms: None` (the clip's own length is unknown -
    an unbounded upload/import clip, see `build_render_plan`) skips the
    clamp rather than treating unknown as zero-length, which would silently
    drop every fade on such a clip regardless of the requested duration."""
    if not raw:
        return None
    duration_ms = raw.get('duration_ms') or 0
    if max_ms is not None:
        duration_ms = min(duration_ms, max_ms)
    if duration_ms <= 0:
        return None
    color = raw.get('color')
    if color not in _FADE_COLORS:
        color = 'black'
    return {'color': color, 'duration_s': duration_ms / 1000}


def _resolve_audio(raw: dict | None, output_duration_s: float, audio_duration_s: float) -> dict:
    """`video_edit.audio` resolved into `{volume, fade_in_s, fade_out_s,
    offset_s}` for `build_ffmpeg_command`'s audio chain. Absent/`None` gives
    exactly the pre-feature behaviour (full volume, no fades, no offset).

    `offset_ms` is clamped so it can never swallow the whole track (which
    would render silence), and the two fades are compressed proportionally if
    together they would outlast the output - the same clamp
    `_resolve_overlays` applies to an overlay's own fade pair, and for the
    same reason: two ramps that cross over produce a dip in the middle that
    nobody asked for."""
    audio = {**_DEFAULT_AUDIO, **(raw or {})}
    try:
        volume = float(audio['volume'])
    except (TypeError, ValueError):
        volume = 1.0
    volume = min(_MAX_AUDIO_VOLUME, max(0.0, volume))
    offset_ms = min(max(0.0, float(audio.get('offset_ms') or 0.0)), max(0.0, audio_duration_s * 1000 - 1))
    fade_in_ms = max(0.0, float(audio.get('fade_in_ms') or 0.0))
    fade_out_ms = max(0.0, float(audio.get('fade_out_ms') or 0.0))
    output_ms = max(0.0, output_duration_s * 1000)
    if output_ms > 0 and fade_in_ms + fade_out_ms > output_ms:
        scale = output_ms / (fade_in_ms + fade_out_ms)
        fade_in_ms *= scale
        fade_out_ms *= scale
    return {
        'volume': volume,
        'fade_in_s': fade_in_ms / 1000,
        'fade_out_s': fade_out_ms / 1000,
        'offset_s': offset_ms / 1000,
    }


def _resolve_adjust(raw: dict | None) -> dict | None:
    """`clip.adjust` resolved for the `eq` filter, or `None` when it is
    absent or equal to "no correction" - in which case no filter is emitted
    at all, keeping an untouched clip's chain identical to what it was before
    colour correction existed."""
    if not raw:
        return None
    adjust = {}
    for key, default in _DEFAULT_ADJUST.items():
        try:
            adjust[key] = float(raw.get(key, default))
        except (TypeError, ValueError):
            adjust[key] = default
    # ffmpeg `eq`'s own accepted ranges.
    adjust['brightness'] = min(1.0, max(-1.0, adjust['brightness']))
    adjust['contrast'] = min(2.0, max(-1000.0, adjust['contrast']))
    adjust['saturation'] = min(3.0, max(0.0, adjust['saturation']))
    adjust['gamma'] = min(10.0, max(0.1, adjust['gamma']))
    if adjust == _DEFAULT_ADJUST:
        return None
    return adjust


def _resolve_export(raw: dict | None, width: int, height: int) -> dict:
    """`video_edit.export` resolved into `{width, height, fps, crf, preset}`.

    Resolution scales the canvas the orientation heuristic already picked,
    keeping its aspect ratio, so `'1080p'` means "1080 on the short side"
    whether the canvas is portrait or landscape. Both dimensions are forced
    even - libx264/yuv420p cannot encode an odd one."""
    export = {**_DEFAULT_EXPORT, **(raw or {})}
    short_side = _EXPORT_SHORT_SIDE.get(export.get('resolution'))
    if short_side:
        factor = short_side / min(width, height)
        width = max(2, round(width * factor / 2) * 2)
        height = max(2, round(height * factor / 2) * 2)
    fps = export.get('fps')
    if fps not in _EXPORT_FPS_OPTIONS:
        fps = _FPS
    crf, preset = _EXPORT_QUALITY.get(export.get('quality'), _EXPORT_QUALITY['high'])
    return {
        'width': width, 'height': height, 'fps': fps, 'crf': crf, 'preset': preset,
    }


def build_render_plan(
    project: dict, video_edit: dict, settings: dict | None = None, project_dir: Path | None = None,
) -> dict:
    """Resolution of an EDL against the project's actual scenes/tracks into
    everything `build_ffmpeg_command` needs. Pure (no disk I/O beyond what
    the caller already loaded into `project`/`video_edit`) when `project_dir`
    is omitted - every existing caller that doesn't need real-file fallback
    duration (every test in `test_editor_provider.py`) keeps working
    unchanged. When given, a clip whose length is otherwise unknown (a
    manually uploaded/imported clip - `Video.duration_seconds` is `None`, no
    explicit `trim_end_ms` either) gets one `ffprobe` call against its real
    file as a fallback (`_probe_duration_ms`) - without it, that clip stays
    "unbounded" exactly like before this existed, which silently breaks any
    transition or `fade_out` touching it: `xfade`'s `offset` and `fade_out`'s
    `st` are both absolute-seconds positions `build_ffmpeg_command` cannot
    compute without knowing where the clip's content actually ends. `ffprobe`
    is a blocking subprocess call - `render_to_file` runs this whole function
    inside `asyncio.to_thread` for exactly that reason, same as
    `_run_ffmpeg_render`'s own ffmpeg call."""
    clips = video_edit.get('clips') or []
    if not clips:
        raise RenderPlanError('Таймлайн пуст — добавьте хотя бы один клип')
    track_id = video_edit.get('mureka_track_id')
    if not track_id:
        raise RenderPlanError('Не выбран аудиотрек для монтажа')
    track = _resolve_track(project, track_id)
    audio_duration_s = (track.get('duration_ms') or 0) / 1000
    if audio_duration_s <= 0:
        raise RenderPlanError('У выбранного аудиотрека неизвестна длительность')

    resolved_clips = []
    effective_ms_list = []
    known_ms_list = []  # `None` where the clip's own length is unknown (unbounded)
    total_ms = 0.0
    all_portrait = True
    for clip in clips:
        video = _resolve_clip_video(project, clip['scene_index'], clip['video_id'])
        # `None` (a manually uploaded/imported clip - see the
        # `duration_seconds` comment just below, same convention) doesn't
        # veto portrait: an unknown aspect ratio isn't evidence the clip is
        # landscape, and treating it as one silently forced every timeline
        # with even a single uploaded clip to landscape regardless of what
        # the footage actually was. Only an *explicit* non-9:16 clip does.
        if video.get('aspect_ratio') not in (None, '9:16'):
            all_portrait = False
        # `duration_seconds` is `None` for a manually uploaded/imported clip
        # (`video.save_uploaded_video`/`import_video_batch` never probe the
        # file - see their docstrings) - a real, common case (video import
        # is an existing feature), not just a hypothetical. Trust it as an
        # upper bound only when known; otherwise (unknown AND no explicit
        # `trim_end_ms`) leave the end unbounded rather than collapsing the
        # clip to zero length - `build_ffmpeg_command` then omits the
        # filter's `end=` and ffmpeg simply runs the clip to its own EOF.
        source_duration_ms = (video.get('duration_seconds') or 0) * 1000
        trim_start_ms = max(0, clip.get('trim_start_ms') or 0)
        trim_end_ms = clip.get('trim_end_ms')
        if trim_end_ms is None and source_duration_ms > 0:
            trim_end_ms = source_duration_ms
        if trim_end_ms is None and project_dir is not None:
            probed_ms = _probe_duration_ms(project_dir / video['file_path'])
            if probed_ms:
                trim_end_ms = probed_ms
        if trim_end_ms is not None and trim_end_ms <= trim_start_ms:
            raise RenderPlanError(
                f'Некорректная обрезка клипа сцены {clip["scene_index"]}: '
                f'{trim_start_ms}–{trim_end_ms} мс',
            )
        speed = clip.get('speed') or 1.0
        if speed <= 0:
            raise RenderPlanError(f'Некорректная скорость клипа сцены {clip["scene_index"]}')
        # An unbounded clip's real contribution to the timeline is unknown
        # ahead of time - counted as 0 for the padding estimate below, same
        # "approximate, non-blocking" tradeoff as every other duration-
        # mismatch case (the global `-t` cap on the final command still
        # keeps the overall output correct regardless).
        effective_ms = (trim_end_ms - trim_start_ms) / speed if trim_end_ms is not None else 0.0
        known_ms = effective_ms if trim_end_ms is not None else None
        effective_ms_list.append(effective_ms)
        known_ms_list.append(known_ms)
        total_ms += effective_ms
        resolved_clips.append({
            'file_path': video['file_path'],
            'trim_start_s': trim_start_ms / 1000,
            'trim_end_s': trim_end_ms / 1000 if trim_end_ms is not None else None,
            'speed': speed,
            'reverse': bool(clip.get('reverse')),
            # A freeze clip holds the single frame at `trim_start_ms` for its
            # whole trim window instead of playing it - see
            # `build_ffmpeg_command`'s own branch. Its window length is
            # therefore its *output* length, which is exactly what
            # `effective_ms` above already computed (speed is forced to 1 for
            # such a clip on the editing side), so nothing about the timeline
            # arithmetic, transitions or the tail pad changes for it.
            'freeze': bool(clip.get('freeze')),
            'tpad_s': 0.0,
            'transition_in': None,
            'fade_in': _resolve_fade(clip.get('fade_in'), known_ms),
            'fade_out': _resolve_fade(clip.get('fade_out'), known_ms),
            'fit': _resolve_fit(clip.get('fit')),
            'adjust': _resolve_adjust(clip.get('adjust')),
        })

    # A transition eats into (overlaps) both the clip before it and this one
    # - not extra time - so it has to come back out of `total_ms` before the
    # tail freeze-pad is sized, or the estimate runs long by the sum of every
    # transition's own duration.
    total_transition_ms = 0.0
    for i in range(1, len(clips)):
        raw = clips[i].get('transition_in')
        xfade_name = _TRANSITION_XFADE_NAME.get((raw or {}).get('type'))
        if not xfade_name:
            continue
        # Clamped to whichever neighbour has less *known* content to spare -
        # a transition can never outlast the clip it's blending into or out
        # of. A neighbour with an unknown length (unbounded upload/import
        # clip - `known_ms_list[i] is None`) imposes no clamp from that side
        # rather than collapsing the whole transition to zero: `effective_
        # ms_list`'s "unknown counts as 0" convention is only meant for the
        # tail-pad size estimate below, not as a real upper bound here - an
        # unbounded clip's own trim omits `end=` in `build_ffmpeg_command`
        # (runs to the file's real EOF), which is virtually always long
        # enough to cover a sub-few-second transition.
        known_neighbours = [v for v in (known_ms_list[i - 1], known_ms_list[i]) if v is not None]
        duration_ms = raw.get('duration_ms') or 0
        if known_neighbours:
            duration_ms = min(duration_ms, min(known_neighbours))
        if duration_ms / 1000 < _TRANSITION_MIN_S:
            continue
        resolved_clips[i]['transition_in'] = {'type': xfade_name, 'duration_s': duration_ms / 1000}
        total_transition_ms += duration_ms
    total_ms -= total_transition_ms

    pad_s = max(0.0, audio_duration_s - total_ms / 1000)
    if pad_s > 0:
        resolved_clips[-1]['tpad_s'] = pad_s

    orientation = video_edit.get('canvas_orientation') or 'auto'
    if orientation == 'portrait':
        width, height = _PORTRAIT_CANVAS
    elif orientation == 'landscape':
        width, height = _DEFAULT_CANVAS
    else:
        width, height = _PORTRAIT_CANVAS if all_portrait else _DEFAULT_CANVAS
    # The orientation heuristic above picks the canvas *shape*; the export
    # settings then decide how many pixels and frames that shape gets, so
    # they are resolved second and can only scale what was already chosen.
    export = _resolve_export(video_edit.get('export'), width, height)
    width, height = export['width'], export['height']
    return {
        'clips': resolved_clips,
        'overlays': _resolve_overlays(project, settings or {}, video_edit, width, height, project_dir),
        'audio_file_path': track['file_path'],
        'audio_duration_s': audio_duration_s,
        'audio': _resolve_audio(video_edit.get('audio'), audio_duration_s, audio_duration_s),
        'target_width': width,
        'target_height': height,
        'fps': export['fps'],
        'crf': export['crf'],
        'preset': export['preset'],
        'output_duration_s': audio_duration_s,
    }


def _trim_plan_to_range(plan: dict, range_start_ms: float, range_end_ms: float) -> dict:
    """Post-processes an already-resolved render plan (`build_render_plan`'s
    own output) down to only the `[range_start_ms, range_end_ms)` window of
    its output timeline - the backend half of "Собрать тестовое видео"
    (`start_editor_render` -> `start_render_job` -> here).

    If `range_start_ms` lands inside (or right after) a transition's own
    blend window, the effective start is first pulled back to that
    transition's own start so the preceding clip is kept and the blend
    actually renders - the frontend timeline draws clip blocks back-to-back
    (see this module's own top docstring), so a range typed against that
    display can land exactly on a boundary that, once the transition's real
    overlap is accounted for, already ate into the previous clip; dropping
    that clip would silently turn the transition into a hard cut. The
    rendered test video may then start up to that transition's `duration_ms`
    earlier than what was typed into `TestRangeModal.jsx` - the same "real
    render may differ slightly from the requested range" tolerance transitions
    already have elsewhere in this module.

    Clips entirely outside the (possibly pulled-back) range are dropped; the
    new first/last clip's own `trim_start_s`/`trim_end_s` are tightened to
    whatever part of their own content falls inside the range (the shift is
    converted from output-timeline ms to source-time via `* speed`, same
    direction `build_render_plan` already trims by); a transition into the
    new first clip is cleared as defense-in-depth, in practice never reached
    given `build_render_plan` already refuses to resolve a `transition_in`
    against an unbounded (unknown-duration) neighbour in the first place - the
    pull-back above otherwise guarantees the new first clip's own
    transition_in, if still set, always has its blend partner kept alongside
    it; the tail freeze-pad (`tpad_s`) is cleared from every kept
    clip except recomputed on the new last one, only if the range's own end
    reaches past that clip's real content into what would have been padding.
    Overlays are kept only if they intersect the range, with `start_s`
    shifted so the range's own start becomes the new timeline's zero and
    `duration_s` clamped to the trimmed window's own end.
    `audio_offset_s`/`output_duration_s` replace `audio_duration_s` as what
    drives the final `-t` and the audio track's own trim
    (`build_ffmpeg_command`)."""
    clips = plan['clips']

    def content_ms(clip: dict) -> float | None:
        if clip['trim_end_s'] is None:
            return None
        return (clip['trim_end_s'] - clip['trim_start_s']) * 1000 / clip['speed']

    # Cumulative output-timeline start per clip - mirrors the offset math
    # `build_ffmpeg_command`'s own `xfade` chain already computes (a
    # transition into clip `i` starts blending `duration_s` before the
    # combined stream would otherwise reach it, so *this* clip's own start
    # moves back by its own transition's duration, not the next one's).
    # Ignores transition *overlap*'s effect on later boundaries beyond that
    # - the render's own established tolerance for that approximation, see
    # this module's `transition_in` docstring, applies here too.
    starts_ms = []
    ends_ms = []  # own real content end, tpad excluded
    cursor_ms = 0.0
    for clip in clips:
        if clip['transition_in']:
            cursor_ms -= clip['transition_in']['duration_s'] * 1000
        starts_ms.append(cursor_ms)
        c_ms = content_ms(clip)
        # An unbounded clip's own contribution is unknown - same "counts as
        # 0" tolerance `build_render_plan` already applies elsewhere; a range
        # spanning past it can't be trimmed precisely, an existing, already-
        # accepted edge case rather than a new one.
        ends_ms.append(cursor_ms + c_ms if c_ms is not None else cursor_ms)
        if c_ms is not None:
            cursor_ms += c_ms + clip['tpad_s'] * 1000

    # Pull `range_start_ms` back to the start of whichever transition's own
    # blend window it lands inside, repeating (bounded by `len(clips)`) since
    # pulling back can expose another transition immediately before it (a run
    # of very short clips each transitioning into the next). Stops as soon as
    # the first still-relevant clip's own transition already starts at or
    # after the current effective start - fully inside the kept range, no
    # further pull-back needed.
    for _ in clips:
        first_idx = next((i for i, end in enumerate(ends_ms) if end > range_start_ms), None)
        if first_idx is None:
            break
        transition = clips[first_idx]['transition_in']
        if not transition or starts_ms[first_idx] >= range_start_ms:
            break
        range_start_ms = max(0.0, starts_ms[first_idx])

    trimmed_clips = []
    kept_end_ms = []
    for i, clip in enumerate(clips):
        clip_start_ms, clip_end_ms = starts_ms[i], ends_ms[i]
        if clip_end_ms <= range_start_ms or clip_start_ms >= range_end_ms:
            continue
        new_clip = dict(clip)
        if clip_start_ms < range_start_ms:
            new_clip['trim_start_s'] += (range_start_ms - clip_start_ms) / 1000 * clip['speed']
        if new_clip['trim_end_s'] is not None and clip_end_ms > range_end_ms:
            new_clip['trim_end_s'] -= (clip_end_ms - range_end_ms) / 1000 * clip['speed']
        new_clip['tpad_s'] = 0.0
        trimmed_clips.append(new_clip)
        kept_end_ms.append(clip_end_ms)

    if not trimmed_clips:
        raise RenderPlanError('Выбранный диапазон не пересекается ни с одним клипом')

    trimmed_clips[0]['transition_in'] = None
    if kept_end_ms[-1] is not None and range_end_ms > kept_end_ms[-1]:
        trimmed_clips[-1]['tpad_s'] = (range_end_ms - kept_end_ms[-1]) / 1000

    trimmed_overlays = []
    for overlay in plan.get('overlays') or []:
        ov_start_ms = overlay['start_s'] * 1000
        ov_end_ms = ov_start_ms + overlay['duration_s'] * 1000
        if ov_end_ms <= range_start_ms or ov_start_ms >= range_end_ms:
            continue
        new_overlay = dict(overlay)
        new_start_ms = max(ov_start_ms, range_start_ms) - range_start_ms
        new_end_ms = min(ov_end_ms, range_end_ms) - range_start_ms
        new_overlay['start_s'] = new_start_ms / 1000
        new_overlay['duration_s'] = (new_end_ms - new_start_ms) / 1000
        trimmed_overlays.append(new_overlay)

    output_duration_s = (range_end_ms - range_start_ms) / 1000
    return {
        **plan,
        'clips': trimmed_clips,
        'overlays': trimmed_overlays,
        # A test render's window is usually far shorter than the whole song,
        # so the user's fade-in/fade-out pair has to be re-clamped against it
        # - otherwise a 5s fade-out on a 10s test render would start before
        # the clip even appears. `range_start_ms` is carried separately as
        # `audio_offset_s` and *added* to the user's own `offset_s` in
        # `build_ffmpeg_command`, not substituted for it.
        'audio': _resolve_audio(
            {
                'volume': plan['audio']['volume'],
                'fade_in_ms': plan['audio']['fade_in_s'] * 1000,
                'fade_out_ms': plan['audio']['fade_out_s'] * 1000,
                'offset_ms': plan['audio']['offset_s'] * 1000,
            },
            output_duration_s,
            plan['audio_duration_s'],
        ),
        'audio_offset_s': range_start_ms / 1000,
        'output_duration_s': output_duration_s,
    }

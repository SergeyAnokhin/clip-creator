"""Render plan -> ffmpeg invocation, and running it.

`build_ffmpeg_command` is the only place that knows ffmpeg's filtergraph
syntax; it reads a plan `editor_plan.build_render_plan` already resolved and
never looks at raw `video_edit` fields itself. `_run_ffmpeg_render` executes
the command as a blocking `subprocess.run` (its caller wraps it in
`asyncio.to_thread` - see `editor.py`'s docstring for why not
`asyncio.create_subprocess_exec`).

Subsystem overview lives in `editor.py`'s own docstring."""

import math
import subprocess
import time
from pathlib import Path

from .. import console_log
from .editor_plan import (
    _DEFAULT_AUDIO_RESOLVED,
    _EXPORT_QUALITY,
    _FPS,
    _overlay_alpha_filters,
)


def build_ffmpeg_command(plan: dict, project_dir: Path, dest_path: Path, fps: int | None = None) -> list[str]:
    """Pure command construction - every input path is resolved but nothing
    is executed here, so this is fully unit-testable without real ffmpeg or
    real files. Only ever maps the built `[vout]`/`[aout]` labels - never
    `-map {i}:a` on a video input, since an AI-generated clip can carry a
    silent embedded audio track that must never leak into the final mux.

    `fps` is normally taken from the plan (`video_edit.export`, resolved by
    `_resolve_export`); the explicit argument stays as an override and falls
    back to `_FPS` for a plan built before the field existed."""
    clips = plan['clips']
    fps = fps or plan.get('fps') or _FPS
    overlays = plan.get('overlays') or []
    w, h = plan['target_width'], plan['target_height']

    cmd = ['ffmpeg', '-y']
    for clip in clips:
        cmd += ['-i', str(project_dir / clip['file_path'])]
    audio_index = len(clips)
    cmd += ['-i', str(project_dir / plan['audio_file_path'])]
    overlay_base_index = audio_index + 1
    for overlay in overlays:
        if overlay['kind'] == 'video':
            # A real video stream, not a looped still - plays from its own
            # start for as long as the `overlay` filter's `enable=` window
            # below stays true (or until it hits its own EOF, whichever
            # comes first - v1 doesn't loop a video overlay shorter than its
            # window, same "approximate, non-blocking" tradeoff as an
            # unbounded clip elsewhere in this module). Never `-map`'d for
            # audio (below, with every other overlay/clip input) - an
            # overlay video is always silent, same "AI clips are silent"
            # convention this module already applies to every main clip.
            cmd += ['-i', str(project_dir / overlay['file_path'])]
        else:
            # `-loop 1` turns the still image into an infinite stream, so the
            # `overlay` filter below has frames for as long as its own
            # `enable='between(...)'` window stays true - bounded by the
            # whole command's final `-t`, not by the image input itself.
            cmd += ['-loop', '1', '-i', str(project_dir / overlay['file_path'])]

    filter_parts = []
    labels = []
    # A clip's own resolved output duration (content + tail freeze-pad, if
    # any) - `None` when unbounded (unknown source length, no explicit trim
    # end). Only needed for transition `offset` math below, but cheap enough
    # to always compute.
    clip_durations_s = []
    for i, clip in enumerate(clips):
        label = f'v{i}'
        # `trim_end_s: None` (unknown source duration, no explicit trim end
        # - see `build_render_plan`) omits `end=` entirely, so ffmpeg just
        # runs this clip to its own EOF instead of collapsing it to zero
        # length.
        trim_end_part = f":end={clip['trim_end_s']:.3f}" if clip['trim_end_s'] is not None else ''
        fit = clip['fit']
        if fit['mode'] == 'contain':
            fit_chain = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        else:
            # `cover`: scale up to *at least* wxh (ffmpeg's own "increase"
            # formula, `max(w/iw, h/ih)`, written out as an expression since
            # the source's actual resolution is only known at ffmpeg's own
            # runtime, not here) times `zoom`, `ceil`'d so the scaled image
            # is never a fraction of a pixel short of wxh (a `trunc` here
            # could round down right at the boundary and make the crop
            # below go negative); then `crop` to exactly wxh, panned within
            # the overscanned image by `offset_x_pct`/`offset_y_pct` (0-100%,
            # 50 = centered) - fills the frame with no letterbox bars.
            scale_expr = (
                f"ceil(iw*max({w}/iw\\,{h}/ih)*{fit['zoom']:.4f}):"
                f"ceil(ih*max({w}/iw\\,{h}/ih)*{fit['zoom']:.4f})"
            )
            crop_expr = (
                f"crop={w}:{h}:(in_w-{w})*{fit['offset_x_pct']:.3f}/100:(in_h-{h})*{fit['offset_y_pct']:.3f}/100"
            )
            fit_chain = f"scale={scale_expr},{crop_expr}"
        # `reverse` buffers the whole trimmed segment and emits it frame-order-
        # reversed - placed right after the speed/PTS-reset (which the filter
        # itself requires: it needs presentation timestamps starting at 0, the
        # same reason the video-overlay branch below resets PTS before its own
        # reverse) and before the scale/crop `fit_chain`, which doesn't care
        # about frame order either way.
        reverse_part = 'reverse,' if clip['reverse'] else ''
        content_duration_s = None
        if clip['trim_end_s'] is not None:
            content_duration_s = (clip['trim_end_s'] - clip['trim_start_s']) / clip['speed']
        if clip.get('freeze') and content_duration_s is not None:
            # Freeze frame: grab exactly one frame at the clip's trim start
            # and clone it for the rest of the clip's own length, rather than
            # playing the window. `reverse`/`speed` are meaningless on a still
            # and are simply not applied (the editing side forces them to
            # their defaults when it creates such a clip).
            frame_s = 1 / fps
            hold_s = max(0.0, content_duration_s - frame_s)
            chain = (
                f"[{i}:v]trim=start={clip['trim_start_s']:.3f}:end={clip['trim_start_s'] + frame_s:.3f},"
                f"setpts=PTS-STARTPTS,"
                f"tpad=stop_mode=clone:stop_duration={hold_s:.3f},"
                f"{fit_chain},setsar=1,fps={fps}"
            )
        else:
            chain = (
                f"[{i}:v]trim=start={clip['trim_start_s']:.3f}{trim_end_part},"
                f"setpts=(PTS-STARTPTS)/{clip['speed']:.4f},"
                f"{reverse_part}{fit_chain},setsar=1,fps={fps}"
            )
        adjust = clip.get('adjust')
        if adjust:
            # After the scale/crop so it costs the fewest pixels, before the
            # fades so a fade still ramps to real black/white rather than to
            # the corrected version of it.
            chain += (
                f",eq=brightness={adjust['brightness']:.3f}:contrast={adjust['contrast']:.3f}"
                f":saturation={adjust['saturation']:.3f}:gamma={adjust['gamma']:.3f}"
            )
        if clip['fade_in']:
            chain += f",fade=t=in:st=0:d={clip['fade_in']['duration_s']:.3f}:color={clip['fade_in']['color']}"
        if clip['fade_out'] and content_duration_s is not None:
            fade_out_st = max(0.0, content_duration_s - clip['fade_out']['duration_s'])
            chain += f",fade=t=out:st={fade_out_st:.3f}:d={clip['fade_out']['duration_s']:.3f}:color={clip['fade_out']['color']}"
        if clip['tpad_s'] > 0:
            chain += f",tpad=stop_mode=clone:stop_duration={clip['tpad_s']:.3f}"
        chain += f"[{label}]"
        filter_parts.append(chain)
        labels.append(f'[{label}]')
        clip_durations_s.append(None if content_duration_s is None else content_duration_s + clip['tpad_s'])

    # With no overlays, the clip chain feeds `[vout]` directly (unchanged
    # from before overlays existed); with overlays, it feeds an intermediate
    # `[vbase]` that the overlay chain below composites onto, ending in
    # `[vout]` itself.
    concat_label = 'vbase' if overlays else 'vout'
    has_transitions = any(clip['transition_in'] for clip in clips)
    if not has_transitions:
        # The common case, unchanged byte-for-byte from before transitions
        # existed: one `concat` over every clip at once.
        filter_parts.append(f"{''.join(labels)}concat=n={len(clips)}:v=1:a=0[{concat_label}]")
    else:
        # At least one boundary is a real crossfade - `xfade` only ever
        # blends exactly two streams, so clips are chained pairwise instead,
        # a hard `concat=n=2` at a boundary with no transition and an
        # `xfade` at one with a resolved `transition_in`. `xfade`'s `offset`
        # is "where in the *combined* stream so far to start blending", so
        # `cumulative_s` tracks that running total - once any clip's own
        # duration is unbounded, it (and every boundary after it) falls back
        # to a hard cut rather than guessing at an offset.
        current_label = '[v0]'
        cumulative_s = clip_durations_s[0]
        for i in range(1, len(clips)):
            this_label = f'[v{i}]'
            transition = clips[i]['transition_in']
            out_label = f'[{concat_label}]' if i == len(clips) - 1 else f'[vjoin{i}]'
            if transition and cumulative_s is not None and clip_durations_s[i] is not None:
                offset_s = max(0.0, cumulative_s - transition['duration_s'])
                filter_parts.append(
                    f"{current_label}{this_label}xfade=transition={transition['type']}:"
                    f"duration={transition['duration_s']:.3f}:offset={offset_s:.3f}{out_label}",
                )
                cumulative_s = cumulative_s + clip_durations_s[i] - transition['duration_s']
            else:
                filter_parts.append(f"{current_label}{this_label}concat=n=2:v=1:a=0{out_label}")
                cumulative_s = (
                    None if cumulative_s is None or clip_durations_s[i] is None
                    else cumulative_s + clip_durations_s[i]
                )
            current_label = out_label
    # Audio chain: `video_edit.audio`'s own offset/volume/fades, plus a test
    # render's window offset on top.
    #
    # The two offsets *add*: `audio['offset_s']` is an editing decision ("the
    # song starts at its chorus") that applies to every render, while
    # `audio_offset_s` is where in that already-offset output the test window
    # begins. Substituting one for the other would silently ignore the user's
    # own offset in every test render.
    #
    # `atrim` cuts, `asetpts` resets the cut's timestamps back to zero (same
    # reason the video `trim` above is always followed by `setpts=PTS-
    # STARTPTS`; without it the mux would start with that much silence),
    # then `volume`/`afade` shape it and `apad` covers any tail the track
    # itself is too short for.
    audio = plan.get('audio') or _DEFAULT_AUDIO_RESOLVED
    total_offset_s = audio['offset_s'] + (plan.get('audio_offset_s') or 0)
    audio_parts = []
    if total_offset_s > 0:
        audio_parts.append(f"atrim=start={total_offset_s:.3f}")
        audio_parts.append('asetpts=PTS-STARTPTS')
    if abs(audio['volume'] - 1.0) > 1e-6:
        audio_parts.append(f"volume={audio['volume']:.3f}")
    if audio['fade_in_s'] > 0:
        audio_parts.append(f"afade=t=in:st=0:d={audio['fade_in_s']:.3f}")
    if audio['fade_out_s'] > 0:
        # Anchored to the end of the *output*, so the ramp always lands on
        # the final frame however the clips were trimmed.
        fade_out_start_s = max(0.0, plan['output_duration_s'] - audio['fade_out_s'])
        audio_parts.append(f"afade=t=out:st={fade_out_start_s:.3f}:d={audio['fade_out_s']:.3f}")
    audio_parts.append('apad')
    filter_parts.append(f"[{audio_index}:a]{','.join(audio_parts)}[aout]")

    if overlays:
        cur = f'[{concat_label}]'
        for i, overlay in enumerate(overlays):
            idx = overlay_base_index + i
            # Both scaled against the canvas's own *width* (`w`, not `h` for
            # `oh_px`) - `height_pct` is a percentage of canvas width, same
            # axis as `width_pct` (see `_migrate_overlay_position`'s
            # docstring), so their ratio always reproduces the overlay's real
            # pixel aspect ratio regardless of the canvas's own w:h shape. Not
            # aspect-locked to the *source image's* own aspect ratio though -
            # matches `CanvasLayer`'s free corner-resize, a deliberate
            # non-uniform stretch is still possible by design.
            ow_px = max(1, round(w * overlay['width_pct'] / 100))
            oh_px = max(1, round(w * overlay['height_pct'] / 100))
            rotation_deg = overlay['rotation_deg']
            x_px = w * overlay['x_pct'] / 100
            y_px = h * overlay['y_pct'] / 100
            # A video overlay's own stream starts decoding from its own
            # frame 0 the instant the whole ffmpeg process starts, in
            # lockstep with every other input - without this, by the time
            # the main timeline reaches `start_s` (when `enable=` below
            # first turns it on), the overlay video would already be
            # `start_s` seconds into its own playback instead of showing its
            # own first frame. Shifting its presentation timestamps forward
            # by `start_s` re-aligns "its own frame 0" with "the moment it
            # becomes visible". Meaningless for an image overlay (`-loop 1`
            # makes every frame identical), so only applied for `kind:
            # 'video'`.
            pre_filter = f"setpts=PTS+{overlay['start_s']:.3f}/TB," if overlay['kind'] == 'video' else ''
            # Same `reverse` filter the main clip chain above uses, gated to
            # `kind: 'video'` like `pre_filter` - applying it to an image
            # overlay's `-loop 1` stream (infinite) would hang, since `reverse`
            # needs a stream with a real end to buffer. Ordered *before*
            # `pre_filter`: `reverse` resets its output's own PTS to start at
            # 0 (buffers the whole clip, replays it back to front), so the
            # frame-0 realignment shift has to apply to *that* new PTS axis,
            # not the original one.
            reverse_filter = 'reverse,' if overlay['kind'] == 'video' and overlay.get('reverse') else ''
            if rotation_deg:
                # Rotates the overlay about its own *top-left* corner (not
                # its center) - exactly what Konva's `Group.rotation` does
                # for `CanvasLayer` (translate to `(x,y)` then rotate, offset
                # always `(0,0)` - see this module's own docstring). ffmpeg's
                # `rotate` filter only ever pivots around its input frame's
                # own center, so the trick is to first pad the scaled image
                # into a frame exactly twice its size with the image placed
                # in the bottom-right quadrant - that puts the image's own
                # top-left corner exactly at the padded frame's center, i.e.
                # the pivot `rotate` will actually use.
                rad = math.radians(rotation_deg)
                padded_w, padded_h = ow_px * 2, oh_px * 2
                rotw_px = max(1, round(abs(padded_w * math.cos(rad)) + abs(padded_h * math.sin(rad))))
                roth_px = max(1, round(abs(padded_w * math.sin(rad)) + abs(padded_h * math.cos(rad))))
                filter_parts.append(
                    f"[{idx}:v]{reverse_filter}{pre_filter}scale={ow_px}:{oh_px},format=rgba,"
                    f"pad={padded_w}:{padded_h}:{ow_px}:{oh_px}:color=0x00000000,"
                    f"rotate={rad:.6f}:ow={rotw_px}:oh={roth_px}:c=none,"
                    f"{_overlay_alpha_filters(overlay)}[ovl{i}]",
                )
                # The padded frame's center - our pivot, still exactly the
                # overlay's own top-left corner - stays fixed by `rotate`,
                # so it sits at the rotated output's own center too: placing
                # *that* at `(x_px, y_px)` is what keeps this pixel-for-pixel
                # aligned with what the live preview's `CanvasLayer` shows.
                x_expr = f'{round(x_px - rotw_px / 2)}'
                y_expr = f'{round(y_px - roth_px / 2)}'
            else:
                filter_parts.append(
                    f"[{idx}:v]{reverse_filter}{pre_filter}scale={ow_px}:{oh_px},format=rgba,{_overlay_alpha_filters(overlay)}[ovl{i}]",
                )
                x_expr = f'{round(x_px)}'
                y_expr = f'{round(y_px)}'
            end_s = overlay['start_s'] + overlay['duration_s']
            out_label = '[vout]' if i == len(overlays) - 1 else f'[vov{i}]'
            filter_parts.append(
                f"{cur}[ovl{i}]overlay=x={x_expr}:y={y_expr}:"
                f"enable='between(t,{overlay['start_s']:.3f},{end_s:.3f})'{out_label}",
            )
            cur = out_label

    cmd += [
        '-filter_complex', ';'.join(filter_parts),
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', plan.get('preset') or _EXPORT_QUALITY['high'][1],
        '-crf', str(plan.get('crf') if plan.get('crf') is not None else _EXPORT_QUALITY['high'][0]),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-t', f"{plan['output_duration_s']:.3f}",
        str(dest_path),
    ]
    return cmd


def _run_ffmpeg_render(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0 and not result.stdout and not result.stderr:
        # ffmpeg.exe killed before it could write anything at all (observed
        # returncode 3221225794 / 0xC0000142 = STATUS_DLL_INIT_FAILED on
        # Windows) is a known antivirus real-time-scan pattern against a
        # freshly spawned process, not a real ffmpeg/filtergraph failure -
        # gone on a second try almost every time, so retry once before
        # treating it as a real error.
        time.sleep(1.0)
        result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        stderr = result.stderr.decode(errors='replace').strip()
        stdout = result.stdout.decode(errors='replace').strip()
        detail = stderr or stdout or (
            'ffmpeg ничего не вывел, хотя завершился с ошибкой, и повторная попытка '
            'тоже не помогла - вероятно, процесс был прерван до запуска (например, '
            'антивирусом). Проверьте лог backend в терминале и добавьте ffmpeg.exe '
            'в исключения антивируса.'
        )
        console_log.log_error(
            'ffmpeg render',
            f'exit={result.returncode} cmd={" ".join(cmd)}\nstderr={stderr!r}\nstdout={stdout!r}',
        )
        raise RuntimeError(f'ffmpeg не смог собрать видео (код {result.returncode}): {detail[-400:]}')

import { useEffect, useState } from 'react';
import { mediaUrl } from '../api/client.js';

const MAX_THUMBS = 6;
const MIN_SLOT_PX = 44;
const THUMB_W = 160;
const THUMB_H = 90;

// key -> string[] (done) | Promise<string[]> (in flight)
const cache = new Map();
// All extraction jobs run through this one promise chain so only a single
// hidden <video> is ever decoding at a time, instead of one decoder per
// clip block on screen.
let queue = Promise.resolve();
let sharedVideo = null;
let sharedCanvas = null;

function workerNodes() {
  if (!sharedVideo) {
    sharedVideo = document.createElement('video');
    sharedVideo.crossOrigin = 'anonymous';
    sharedVideo.muted = true;
    sharedVideo.playsInline = true;
    sharedCanvas = document.createElement('canvas');
    sharedCanvas.width = THUMB_W;
    sharedCanvas.height = THUMB_H;
  }
  return { video: sharedVideo, canvas: sharedCanvas };
}

function loadVideo(video, src) {
  return new Promise((resolve, reject) => {
    function onLoaded() {
      cleanup();
      resolve();
    }
    function onError() {
      cleanup();
      reject(new Error(`thumbnail source failed to load: ${src}`));
    }
    function cleanup() {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    }
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
    video.src = src;
  });
}

function seekTo(video, seconds) {
  return new Promise((resolve) => {
    function onSeeked() {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }
    video.addEventListener('seeked', onSeeked);
    video.currentTime = seconds;
  });
}

async function extractFrames(src, timestampsMs) {
  const { video, canvas } = workerNodes();
  const ctx = canvas.getContext('2d');
  await loadVideo(video, src);
  const frames = [];
  for (const ms of timestampsMs) {
    // eslint-disable-next-line no-await-in-loop -- frames must be captured in order, one seek at a time, on the one shared <video>
    await seekTo(video, Math.max(0, Math.min(ms / 1000, video.duration || ms / 1000)));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL('image/jpeg', 0.72));
  }
  return frames;
}

function enqueue(job) {
  const result = queue.then(job, job);
  // A failed job must not wedge every extraction queued after it.
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function thumbCountForWidth(widthPx) {
  return Math.max(1, Math.min(MAX_THUMBS, Math.floor(widthPx / MIN_SLOT_PX)));
}

/** Real frames sampled from a timeline clip's own trimmed window - not the
 * scene's static marketing image, and not the first/last frame (which can
 * be a black flash or a mid-cut artifact), but interior midpoints spread
 * evenly across `[trimStartMs, trimEndMs]`: for 2 thumbnails that lands at
 * the 25%/75% marks, i.e. "one near the start, one near the end" without
 * ever being the literal edge frame. `widthPx` is the clip block's own
 * rendered width - more thumbnails appear automatically as it gets wider.
 * Results are cached by video/trim/count (module-level, survives
 * remounts/zoom/scroll) and every extraction is serialized through one
 * shared hidden <video> (see `enqueue` above) so decoding many clips at
 * once doesn't fight over resources. */
export function useClipThumbnails({ projectId, video, trimStartMs, trimEndMs, widthPx }) {
  const count = thumbCountForWidth(widthPx);
  const key = video ? `${projectId}|${video.video_id}|${trimStartMs}|${trimEndMs}|${count}` : null;
  const [frames, setFrames] = useState(() => {
    const entry = key && cache.get(key);
    return Array.isArray(entry) ? entry : [];
  });

  useEffect(() => {
    if (!key || !video) {
      setFrames([]);
      return undefined;
    }
    let entry = cache.get(key);
    if (Array.isArray(entry)) {
      setFrames(entry);
      return undefined;
    }
    if (!entry) {
      const src = mediaUrl(`projects/${projectId}/${video.file_path}`);
      const span = Math.max(0, trimEndMs - trimStartMs);
      const timestamps = Array.from({ length: count }, (_, i) => trimStartMs + ((i + 0.5) / count) * span);
      entry = enqueue(() => extractFrames(src, timestamps))
        .then((result) => { cache.set(key, result); return result; })
        .catch(() => { cache.delete(key); return []; });
      cache.set(key, entry);
    }
    let cancelled = false;
    entry.then((result) => { if (!cancelled) setFrames(result); });
    return () => { cancelled = true; };
  }, [key, video, projectId, trimStartMs, trimEndMs, count]);

  return frames;
}

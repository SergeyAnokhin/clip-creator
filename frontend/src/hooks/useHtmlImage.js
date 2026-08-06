import { useEffect, useState } from 'react';

/** Loads a plain `<img>` (not a React element - the raw DOM Image object,
 * for react-konva's `<Image image={...} />`) and reports its natural pixel
 * size once loaded.
 *
 * Fetches the URL as a blob and points the Image at a `blob:` object URL
 * instead of the API's `http://localhost:8020/...` URL directly - a plain
 * `<img src>` (used by PosterConstructor.jsx's own picker thumbnails) and a
 * `crossOrigin="anonymous"` load of the *same* URL hit the same browser HTTP
 * cache entry, and Chrome serves the second one from that cache without
 * re-validating CORS, failing with `net::ERR_FAILED` (confirmed in this
 * app's dev session, 2026-08) even though the backend's CORS headers are
 * correct (see main.py's CORSMiddleware) - a `blob:` URL sidesteps the whole
 * cross-origin/cache-mode question since it's always same-origin for
 * `stage.toDataURL()`/`toBlob()` purposes. */
export function useHtmlImage(url) {
  const [state, setState] = useState({ image: null, width: 0, height: 0, loaded: false });

  useEffect(() => {
    if (!url) {
      setState({ image: null, width: 0, height: 0, loaded: false });
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        const img = new window.Image();
        img.onload = () => {
          if (!cancelled) setState({ image: img, width: img.naturalWidth, height: img.naturalHeight, loaded: true });
        };
        img.src = objectUrl;
      })
      .catch(() => { if (!cancelled) setState({ image: null, width: 0, height: 0, loaded: false }); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return state;
}

import { useEffect, useState } from 'react';

/** Loads a plain `<img>` (not a React element - the raw DOM Image object,
 * for react-konva's `<Image image={...} />`) and reports its natural pixel
 * size once loaded.
 *
 * Fetches the URL as a blob and points the Image at a `blob:` object URL
 * instead of the API's `http://localhost:8020/...` URL directly - a plain
 * `<img src>` elsewhere in the app pointed at the *same* URL (e.g. a picker
 * thumbnail - PosterConstructor.jsx's own, or EditorTimelineTools.jsx's
 * overlay picker) and this hook's `fetch` of that URL hit the same browser
 * HTTP cache entry, and Chrome serves the second one from that cache without
 * re-validating CORS, failing with `net::ERR_FAILED` (confirmed in this
 * app's dev session, 2026-08 - caught live as the Editor stage's overlay
 * canvas silently never rendering a logo whose picker thumbnail had already
 * loaded) even though the backend's CORS headers are correct (see main.py's
 * CORSMiddleware). `cache: 'no-store'` makes this fetch always hit the
 * network fresh instead of consulting/populating that shared cache entry,
 * sidestepping the collision regardless of what other `<img>` tags on the
 * page have already requested the same URL - a `blob:` URL then sidesteps
 * the cross-origin question for `stage.toDataURL()`/`toBlob()` purposes. */
export function useHtmlImage(url) {
  const [state, setState] = useState({ image: null, width: 0, height: 0, loaded: false });

  useEffect(() => {
    if (!url) {
      setState({ image: null, width: 0, height: 0, loaded: false });
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    fetch(url, { cache: 'no-store' })
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

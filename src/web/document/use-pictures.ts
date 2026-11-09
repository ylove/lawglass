import { useEffect, useRef, useState } from 'react';
import type { PictureEntry, PicturesResponse } from '../../core/model/index.js';

const NO_PICTURES: readonly PictureEntry[] = [];

/**
 * The pictures for a summary or breakdown (#345), once `active` (the text they illustrate has
 * arrived). They are an enhancement: while the server is still drawing we ask again, up to
 * `maxWaitMs`; on any error, `none`, `disabled` or a timeout we quietly show no pictures. Nothing
 * here ever sets an error state, moves focus or announces anything.
 */
export function usePictures(
  load: (signal: AbortSignal) => Promise<PicturesResponse>,
  active: boolean,
  key: string,
  pollMs: number,
  maxWaitMs: number,
  /** Changing it looks again, e.g. when the text the pictures illustrate has been completed. */
  phase = 0,
): readonly PictureEntry[] {
  // Tagged with the key it was loaded for, so pictures of a previous document or text are never
  // shown for the next one while the new ones load.
  const [loaded, setLoaded] = useState<{
    key: string;
    entries: readonly PictureEntry[];
  }>({ key: '', entries: [] });
  // Always the latest loader, without making a new render restart the polling.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // Restarts whenever more pictures arrive: a long bill is drawn a group at a time (#382).
    let lastProgress = Date.now();
    let seen = 0;
    const look = () => {
      loadRef
        .current(controller.signal)
        .then((r) => {
          if (!live) return;
          if (r.status === 'cached')
            setLoaded({ key, entries: r.entries ?? [] });
          else if (r.status === 'pending') {
            const entries = r.entries ?? [];
            if (entries.length > seen) {
              seen = entries.length;
              lastProgress = Date.now();
              setLoaded({ key, entries });
            }
            if (Date.now() - lastProgress < maxWaitMs)
              timer = setTimeout(look, pollMs);
          }
        })
        .catch(() => {
          // Pictures are optional: no error state, no retry.
        });
    };
    look();
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, key, pollMs, maxWaitMs, phase]);

  return active && loaded.key === key ? loaded.entries : NO_PICTURES;
}

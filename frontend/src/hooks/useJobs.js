import { useCallback, useEffect, useRef, useState } from 'react';

/** Registry of long-running (usually paid) background jobs, owned by App so it
 * outlives stage navigation - the second such exception alongside
 * `useMiniPlayer.js`. Before this, a generation's only visible trace was a
 * spinner inside the stage that started it, so switching stages made a running
 * job invisible and switching projects made its result land in the wrong one.
 *
 * A job is registered by the stage hook that starts it and removed in its
 * `finally`; nothing here polls or cancels - the hooks keep owning that. The
 * `projectId` a job was begun under is what `JobsPill` shows and what stage
 * hooks compare against before writing a result back (see `isStale`). */
export function useJobs() {
  const [jobs, setJobs] = useState([]);
  const nextId = useRef(1);

  const beginJob = useCallback((meta) => {
    const id = nextId.current++;
    setJobs((list) => [...list, { id, startedAt: Date.now(), ...meta }]);
    return id;
  }, []);

  const endJob = useCallback((id) => {
    setJobs((list) => list.filter((j) => j.id !== id));
  }, []);

  return { jobs, beginJob, endJob };
}

/** Ticks once a second while `active`, so an elapsed-time readout re-renders
 * without every idle header paying for an interval. */
export function useElapsedTick(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

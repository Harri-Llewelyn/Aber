import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks one button's in-flight state and refuses to start the action twice: `pending` disables the
 * button, and the ref covers the gap before React commits the disabled attribute. The mounted ref
 * exists because a successful mutation usually unmounts the button before its `finally` runs. `run`
 * propagates whatever the action threw; every call site catches and reports through showToast.
 * Usage: `const [saving, runSave] = usePendingAction()`, then `runSave(save)` from the button's
 * onClick with `pending={saving}`.
 */
/**
 * The same for a list of buttons, answering which row is running. Only one at a time: each row
 * mutation reloads the list underneath, and overlapping reloads race to set the same state.
 */
export function usePendingKey() {
  const [pendingKey, setPendingKey] = useState(null);
  const keyRef = useRef(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const run = useCallback(async (key, fn) => {
    if (keyRef.current !== null) return undefined;
    keyRef.current = key;
    setPendingKey(key);
    try {
      return await fn();
    } finally {
      keyRef.current = null;
      if (mounted.current) setPendingKey(null);
    }
  }, []);

  return [pendingKey, run];
}

export function usePendingAction() {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const run = useCallback(async (fn) => {
    if (pendingRef.current) return undefined;
    pendingRef.current = true;
    setPending(true);
    try {
      return await fn();
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return [pending, run];
}

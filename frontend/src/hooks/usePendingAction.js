import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks one button's in-flight state, and refuses to start the action twice.
 *
 * THE DOUBLE-SUBMIT GUARD IS NOT INCIDENTAL. Before this, every save/archive/approve button was
 * live for the whole round trip, so a double click on a slow connection sent the mutation twice --
 * two archive POSTs, two device inserts. Disabling the button through `pending` closes that in the
 * UI, and the ref closes it for the gap between the click and React committing the disabled
 * attribute, which is exactly the window a double click lands in.
 *
 * Usage:
 *   const [saving, runSave] = usePendingAction()
 *   <ActionButton pending={saving} pendingLabel="Saving…" onClick={() => runSave(save)}>Save</ActionButton>
 *
 * The mounted ref exists because the usual outcome of a successful mutation is the modal closing,
 * which unmounts the button before its own `finally` runs.
 *
 * `run` PROPAGATES whatever the action threw rather than swallowing it: an error that disappears
 * with no toast and no console entry is the worst of the available outcomes. Every call site in
 * this app passes a handler that catches internally and reports through showToast, so none of them
 * floats a rejected promise -- a caller that does not handle its own errors must not either.
 */
/**
 * The same thing for a LIST of buttons, where the question is not "is something running" but
 * "which row is running".
 *
 * A table of Restore buttons cannot share one boolean: it would spin every row in the table for a
 * click on one of them, which says something actively untrue about what the app is doing.
 *
 * Only one at a time, deliberately. These are row mutations that each trigger a full reload of
 * the list underneath them; letting three overlap means three reloads racing to set the same
 * state, and the last one to land wins regardless of which finished first.
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

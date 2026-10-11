import { useEffect, useSyncExternalStore } from 'react'
import {
  getConnectionSnapshot,
  subscribeToConnection,
  resetConnectionState,
  watchBrowserConnectivity
} from '../lib/connectionState'

/**
 * What the strip under the top bar should say: `{ status, failing, since }` from
 * lib/connectionState. Used once, by the signed-in shell. Mounting starts from a clean state and
 * follows the browser's online and offline events; unmounting (signing out) forgets the state, so
 * the next session never inherits it.
 */
export function useConnectionStatus() {
  useEffect(() => {
    resetConnectionState()
    const stopWatching = watchBrowserConnectivity()
    return () => {
      stopWatching()
      resetConnectionState()
    }
  }, [])

  return useSyncExternalStore(subscribeToConnection, getConnectionSnapshot)
}

import { useState, useCallback } from 'react'

/**
 * Custom hook to manage toast notification state with a stable useCallback showToast reference.
 */
export function useToast() {
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
  }, [])

  const clearToast = useCallback(() => {
    setToast(null)
  }, [])

  return {
    toast,
    showToast,
    clearToast
  }
}

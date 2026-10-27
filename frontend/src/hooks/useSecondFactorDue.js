import { useEffect, useState } from 'react'
import { api } from '../api'
import { secondFactorDue } from '../utils/secondFactor'

/**
 * Whether this session must give a code before the dashboard opens: `undefined` while the first
 * answer for this person is read, then true or false. Asked again whenever the access token
 * changes (a refresh, a code verified, a factor removed), keeping the last answer meanwhile.
 *
 * The question is a prompt, not a gate: an answer that cannot be read opens the dashboard rather
 * than holding the person at a screen they may not be able to pass.
 */
export function useSecondFactorDue(session) {
  const userId = session?.user?.id ?? null
  const token = session?.access_token ?? null
  const [answer, setAnswer] = useState({ userId: null, due: undefined })

  useEffect(() => {
    if (!userId || !token) return undefined
    let current = true
    Promise.resolve()
      .then(() => api.assuranceLevel())
      .then(level => { if (current) setAnswer({ userId, due: secondFactorDue(level) }) })
      .catch(err => {
        console.warn('[mfa] could not read how this session signed in:', err?.message)
        if (current) setAnswer({ userId, due: false })
      })
    return () => { current = false }
  }, [userId, token])

  // No token, no assurance level to read: nothing to ask.
  if (!userId || !token) return false
  return answer.userId === userId ? answer.due : undefined
}

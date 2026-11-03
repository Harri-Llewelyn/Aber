import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { EmptyState } from '../common/EmptyState'
import { IconPlus, IconShieldAlert } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { ColumnHeader } from '../common/SortHeader'
import { AddSecondFactorModal } from '../modals/AddSecondFactorModal'
import { RemoveSecondFactorModal } from '../modals/RemoveSecondFactorModal'
import { tabUrl } from '../../routes'
import { formatDateTime } from '../../utils/format'
import { factorLabel, verifiedFactors } from '../../utils/secondFactor'

/** Where every message about an authenticator links: this tab. */
const MFA_URL = tabUrl('profile', 'mfa')

/**
 * Profile's MFA tab: the authenticator apps the signed-in person has added (GoTrue's verified TOTP
 * factors, read through auth-js), with Add Authenticator and a Remove on
 * each row. Every role may add one. Once one is added, signing in asks for its code after the
 * password (components/auth/SecondFactorChallenge.jsx). Nothing on the site requires one.
 *
 * `isPerson` is false for a machine identity, which signs in with a token and has none.
 */
export function SecondFactorSection({ isPerson = true, showToast }) {
  // undefined while the first read runs; the rows stay on screen while a later one does.
  const [factors, setFactors] = useState(undefined)
  // This session's level, so Remove knows whether GoTrue will want a code first (aal1).
  const [level, setLevel] = useState(null)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)

  const load = useCallback(async () => {
    try {
      const [all, assurance] = await Promise.all([api.listMyFactors(), api.assuranceLevel().catch(() => null)])
      setFactors(verifiedFactors(all))
      setLevel(assurance?.currentLevel ?? null)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { if (isPerson) load() }, [isPerson, load])

  const added = (factor) => {
    showToast?.(`Authenticator added: ${factorLabel(factor)}. You give its code each time you sign in.`, 'success',
      { to: MFA_URL })
    load()
  }

  const removed = (factor) => {
    showToast?.(`Authenticator removed: ${factorLabel(factor)}.`, 'success', { to: MFA_URL })
    setRemoving(null)
    load()
  }

  // A fragment, not a wrapper: the table must stay a direct child of the card.
  return (
    <>
      {/* The tab explains itself in its tooltip; the row under the bar holds only its button. */}
      {isPerson && (
        <div className="filter-bar">
          <div className="filter-bar-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={factors === undefined && !error}
              onClick={() => setAdding(true)}
            >
              <IconPlus size={13} /> Add Authenticator
            </button>
          </div>
        </div>
      )}

      {!isPerson ? (
        <EmptyState message="A machine identity signs in with a token, so it has no MFA." />
      ) : error ? (
        <div className="card-body">
          <div className="callout callout-danger" role="status">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>{error}</div>
          </div>
        </div>
      ) : factors === undefined ? (
        <LoadingState label="authenticators" />
      ) : factors.length === 0 ? (
        <EmptyState message="You have not set up MFA. Your password alone signs you in." />
      ) : (
        <div className="table-wrap second-factor-table">
          <table>
            <thead>
              <tr>
                <ColumnHeader title="The name you gave the authenticator app when you added it.">Name</ColumnHeader>
                <ColumnHeader title="When you added it.">Added</ColumnHeader>
                <th className="row-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {factors.map(f => (
                <tr key={f.id} data-factor={f.id}>
                  <td>{factorLabel(f)}</td>
                  <td className="cell-meta">{formatDateTime(f.created_at)}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setRemoving(f)}
                      aria-label={`Remove the authenticator: ${factorLabel(f)}`}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddSecondFactorModal
          factors={factors || []}
          onAdded={added}
          onClose={() => setAdding(false)}
        />
      )}

      {removing && (
        <RemoveSecondFactorModal
          factor={removing}
          others={(factors || []).filter(f => f.id !== removing.id)}
          needsCode={level !== 'aal2'}
          onRemoved={removed}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  )
}

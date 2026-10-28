import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { IconPlus, IconShieldAlert } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { ColumnHeader } from '../common/SortHeader'
import { AddSecondFactorModal } from '../modals/AddSecondFactorModal'
import { RemoveSecondFactorModal } from '../modals/RemoveSecondFactorModal'
import { tabUrl } from '../../routes'
import { formatDateTime } from '../../utils/format'
import { factorLabel, verifiedFactors } from '../../utils/secondFactor'

/** Where every message about a second factor links: this section. */
const SECURITY_URL = tabUrl('profile', 'security')

/**
 * The Security tab's Second factor section: the authenticator apps the signed-in person has added
 * (GoTrue's verified TOTP factors, read through auth-js), with Add Second Factor and a Remove on
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
    showToast?.(`Second factor added: ${factorLabel(factor)}. You give its code each time you sign in.`, 'success',
      { to: SECURITY_URL })
    load()
  }

  const removed = (factor) => {
    showToast?.(`Second factor removed: ${factorLabel(factor)}.`, 'success', { to: SECURITY_URL })
    setRemoving(null)
    load()
  }

  // A fragment, not a wrapper: the table must stay a direct child of the card.
  return (
    <>
      <div className="card-body profile-section-head second-factor-head">
        <div className="profile-section-heading">
          <h4 className="profile-section-title">Second factor</h4>
          <HelpTip
            label="About second factors"
            text="A code from an authenticator app on your phone, asked for after your password each time you sign in. Someone who learns your password cannot sign in without it. Any app that shows 6-digit codes works."
          />
          {isPerson && (
            <div className="profile-section-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={factors === undefined && !error}
                onClick={() => setAdding(true)}
              >
                <IconPlus size={13} /> Add Second Factor
              </button>
            </div>
          )}
        </div>
        <p className="profile-section-note">
          Optional for every role. With one added, signing in asks for its code after your password,
          for the dashboard and for the services that sign in through it.
        </p>
      </div>

      {!isPerson ? (
        <EmptyState message="A machine identity signs in with a token, so it has no second factor." />
      ) : error ? (
        <div className="card-body">
          <div className="callout callout-danger" role="status">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>{error}</div>
          </div>
        </div>
      ) : factors === undefined ? (
        <LoadingState label="second factors" />
      ) : factors.length === 0 ? (
        <EmptyState message="You have no second factor. Your password alone signs you in." />
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
                      aria-label={`Remove the second factor: ${factorLabel(f)}`}
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

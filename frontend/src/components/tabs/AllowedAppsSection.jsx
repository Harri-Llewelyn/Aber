import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { AppApprovalsTable } from '../common/AppApprovalsTable'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { IconShieldAlert } from '../common/Icons'
import { LoadingState } from '../common/LoadingState'
import { ConfirmModal } from '../modals/ConfirmModal'
import { tabUrl } from '../../routes'
import { appLabel, revokeQuestion } from '../../utils/apps'

/** Where every message about an approval links: this list. */
const APPS_URL = tabUrl('profile', 'security')

/**
 * The Security tab's Apps you have allowed: each app the signed-in person let sign them in with
 * their Aber account (`list_my_app_approvals()`, 0217), with when and what it may read. Revoke
 * takes one back through the sign-in service's own endpoint (`revokeGrant`), which also ends that
 * app's sessions for them, after a dialog that says so. Recorded in the Audit Trail.
 *
 * `isPerson` is false for a machine identity, which allows no apps.
 */
export function AllowedAppsSection({ isPerson = true, showToast }) {
  // undefined while the first read runs; the rows stay on screen while a later one does.
  const [approvals, setApprovals] = useState(undefined)
  const [error, setError] = useState(null)
  // The approval Revoke asks about, while its dialog is open.
  const [confirming, setConfirming] = useState(null)

  const load = useCallback(async () => {
    try {
      setApprovals(await api.listMyAppApprovals())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { if (isPerson) load() }, [isPerson, load])

  const revoke = async () => {
    const app = appLabel(confirming.client_name)
    try {
      await api.revokeMyAppApproval(confirming.client_id)
      showToast?.(
        `${app} is revoked. Its sessions for you have ended, and it asks you to allow it again next time.`,
        'success',
        { to: APPS_URL },
      )
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setConfirming(null)
      await load()
    }
  }

  const rows = (approvals || []).map(a => ({
    key: a.client_id,
    label: (
      <>
        <span className="session-where">{appLabel(a.client_name)}</span>
        {a.part_of_stack && <Badge size="sm" className="session-badge" title="One of Aber's own services">Aber</Badge>}
      </>
    ),
    description: appLabel(a.client_name),
    granted_at: a.granted_at,
    scopes: a.scopes,
    approval: a,
  }))

  // A fragment, not a wrapper: the table must stay a direct child of the card, which scrolls it.
  return (
    <>
      <div className="card-body profile-section-head">
        <div className="profile-section-heading">
          <h4 className="profile-section-title">Apps you have allowed</h4>
          <HelpTip
            label="About apps you have allowed"
            text="The first time an app such as Grafana signs you in with your Aber account, it asks you to allow it. Revoke signs that app out and makes it ask again. It does not change your role."
          />
        </div>
        <p className="profile-section-note">
          Each app you let sign you in, when you allowed it, and what it can read about you.
        </p>
      </div>

      {!isPerson ? (
        <EmptyState message="A machine identity allows no apps. It holds a token of its own." />
      ) : error ? (
        <div className="card-body">
          <div className="callout callout-danger" role="status">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>{error}</div>
          </div>
        </div>
      ) : approvals === undefined ? (
        <LoadingState label="apps" />
      ) : rows.length === 0 ? (
        <EmptyState message="You have not allowed any app." />
      ) : (
        <AppApprovalsTable
          rows={rows}
          first={{ title: 'App', tip: 'The app that signs you in with your Aber account.' }}
          onRevoke={r => setConfirming(r.approval)}
        />
      )}

      {confirming && (
        <ConfirmModal
          title={`Revoke ${appLabel(confirming.client_name)}`}
          icon={<IconShieldAlert size={18} />}
          message={revokeQuestion(confirming.client_name)}
          confirmLabel="Revoke Approval"
          pendingLabel="Revoking…"
          onConfirm={revoke}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  )
}

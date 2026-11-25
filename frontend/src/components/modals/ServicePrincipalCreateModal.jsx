import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { GRANTABLE_PERMISSIONS, permissionReach } from '../../utils/serviceIdentities'
import { identityUrl } from '../../routes'
import { useFormCheck } from '../../hooks/useFormCheck'

const NAME_MAX = 80
const PURPOSE_MAX = 500

/**
 * Create a machine identity from the Access Control page: a name, a purpose and a set of
 * permissions from the fixed menu. One RPC, `create_machine_principal()`, and no token: the
 * identity reaches nothing until one is signed, and the page opens the token dialog next so the
 * first token is shown once the way every other is. An identity left without a token is harmless,
 * and Withdraw covers it.
 *
 * The menu is `GRANTABLE_PERMISSIONS`, exactly what the function allows; the build asserts the
 * two agree. Permissions and never a role: a role changes whenever somebody widens it for the
 * people who hold it.
 */
export function ServicePrincipalCreateModal({ onClose, onCreated, showToast }) {
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [permissions, setPermissions] = useState(() => new Set([GRANTABLE_PERMISSIONS[0]]))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const nameRef = useRef(null)

  const toggle = useCallback((perm) => {
    setPermissions(prev => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }, [])

  const trimmedName = name.trim()
  // The fields' maxLength holds the upper bounds; what is left to say is what is missing.
  const check = useFormCheck({
    name: { id: 'principal-name', missing: trimmedName.length === 0 && 'Give the identity a name' },
    holds: { id: 'principal-holds', missing: permissions.size === 0 && 'Choose at least one permission for it to hold' },
  })

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // In menu order, not click order, so two identities given the same set list it the same way.
      const chosen = GRANTABLE_PERMISSIONS.filter(p => permissions.has(p))
      const created = await api.createServicePrincipal(trimmedName, chosen, purpose.trim())
      showToast?.(`${trimmedName} created — it holds no token yet`, 'success', { to: identityUrl(trimmedName) })
      // The name is carried from here: the RPC does not return it, and the caller is the one who
      // typed it.
      onCreated?.({ ...created, name: trimmedName })
      onClose()
    } catch (err) {
      // THE DIALOG STAYS OPEN with what was typed: the database refused the whole transaction, so
      // nothing was created and the operator corrects the field the message names.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [trimmedName, purpose, permissions, onCreated, onClose, showToast])

  return (
    <Modal
      title="New Machine Identity"
      size="md"
      busy={busy}
      onClose={onClose}
      lead={<>
        An identity for a process that reaches this stack's <strong>database</strong> through the
        API: a reporting tool, an MCP client, a script. It cannot sign in, holds the permissions
        chosen here and nothing else, and <strong>does not reach the broker</strong> — an MQTT
        client is issued a broker account, not a machine identity.
      </>}
      initialFocus={nameRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton
          pending={busy}
          pendingLabel="Creating…"
          className="btn btn-primary"
          onClick={() => check.press(submit)}
          title="Create the identity. No token is issued until you choose to."
        >
          Create Machine Identity
        </ActionButton>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="principal-name">Name <RequiredMark /></label>
        <input
          id="principal-name"
          className="form-control"
          ref={nameRef}
          autoComplete="off"
          maxLength={NAME_MAX}
          placeholder="e.g. Line 4 OEE report"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-required="true"
          {...fieldErrorProps(check.errors.name, 'principal-name-error', 'principal-name-hint')}
        />
        <div id="principal-name-hint" className="form-hint">What the page lists it as. Unique, ignoring case.</div>
        <FieldError id="principal-name-error" error={check.errors.name} />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="principal-purpose">Purpose (optional)</label>
        <textarea
          id="principal-purpose"
          className="form-control"
          rows={3}
          maxLength={PURPOSE_MAX}
          placeholder="What presents this identity, and why it needs what it holds"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          style={{ resize: 'vertical' }}
        />
        <div className="form-hint">
          Shown beside the name. It is what makes an unfamiliar identity safe to leave alone or safe
          to remove.
        </div>
      </div>

      <fieldset
        id="principal-holds"
        className="form-group"
        style={{ border: 'none', margin: 0, padding: 0 }}
        aria-describedby={check.errors.holds ? 'principal-holds-error' : undefined}
      >
        <legend className="form-label">Holds <RequiredMark title="Required: at least one" /></legend>
        {GRANTABLE_PERMISSIONS.map(perm => (
          <label
            key={perm}
            style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '4px 0', cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={permissions.has(perm)}
              onChange={() => toggle(perm)}
              style={{ marginTop: '3px' }}
            />
            <span>
              <Badge size="sm">{perm}</Badge>
              <div className="cell-meta" style={{ marginTop: '2px' }}>{permissionReach([perm])}</div>
            </span>
          </label>
        ))}
        {/* Why the menu stops where it does, said where the reader is choosing. */}
        <div className="form-hint">
          Permissions, never a role. Machines propose, people decide: a machine may file
          proposals and version schemas, never write a device, decide a proposal or a quarantine,
          or change who has access. Withdrawing the identity or revoking a token refuses it at the
          API from the next request.
        </div>
        <FieldError id="principal-holds-error" error={check.errors.holds} />
      </fieldset>
    </Modal>
  )
}

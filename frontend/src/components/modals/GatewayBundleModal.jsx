import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { formatCountdown, tokenTimeRemaining } from '../../utils/gatewayStatus'
import { typedNameMatches } from '../../utils/gatewayType'
import {
  IconCheck, IconCopy, IconDownload, IconRefreshCw, IconShieldAlert
} from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * The setup step for a remote gateway: issues a single-use token and shows it as an install
 * command to paste on the appliance, or downloads it as a ZIP bundle. Issuing replaces any live
 * token for the gateway, so `confirmFirst` (the drawer's routes) asks for the gateway's name
 * first; straight after creating the gateway there is nothing to replace and it issues on open,
 * once per mount. The command is offered when `installer.available`; switching between command and
 * bundle is a re-issue and asks first.
 *
 * Escape and the close button back out of the confirm step when a token is on screen behind it,
 * and close the dialog otherwise.
 */
export function GatewayBundleModal({ gateway, onClose, showToast, confirmFirst = false, installer = null }) {
  const [step, setStep] = useState(confirmFirst ? 'confirm' : 'ready')
  const [typed, setTyped] = useState('')
  const [bundle, setBundle] = useState(null)
  // 'command' or 'bundle': what the next issue produces.
  const [mode, setMode] = useState(installer?.available ? 'command' : 'bundle')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(!confirmFirst)
  const [copied, setCopied] = useState(null)
  // Re-rendered every second only while a live token is on screen.
  const [now, setNow] = useState(() => Date.now())

  const requested = useRef(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const remaining = bundle ? tokenTimeRemaining(bundle.expiresAt, now) : null
  const expired = remaining !== null && remaining <= 0
  const confirmed = typedNameMatches(typed, gateway.gateway_name)

  useEffect(() => {
    if (!bundle || expired || step !== 'ready') return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [bundle, expired, step])

  const generate = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'command') {
        const result = await api.installCommand(gateway.gateway_id)
        setBundle({ ...result, kind: 'command' })
        setNow(Date.now())
        setTyped('')
        setStep('ready')
        showToast?.(`Install command issued for '${gateway.gateway_name}'`, 'success')
        return
      }

      const result = await api.downloadGatewayBundle(gateway.gateway_id)

      // An object URL, not a data: URL, which some browsers cap silently.
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename || `aber-gateway-${gateway.sparkplug_id || 'bundle'}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)

      setBundle({ ...result, kind: 'bundle' })
      setNow(Date.now())
      setTyped('')
      setStep('ready')
      showToast?.(`Bundle downloaded for '${gateway.gateway_name}'`, 'success')
    } catch (err) {
      // The step is not advanced: nothing was issued, so the previous token is still live. A 503 is
      // the deployment (the address an appliance would dial is unset), so no retry is offered.
      setError({ message: err.message, details: err.details || null, deployment: err.status === 503 })
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [gateway, mode, showToast])

  useEffect(() => {
    if (confirmFirst || requested.current) return
    requested.current = true
    generate()
  }, [confirmFirst, generate])

  const sparkplugId = bundle?.sparkplugId || gateway.sparkplug_id
  const folder = bundle?.filename
    ? bundle.filename.replace(/\.zip$/, '')
    : `aber-gateway-${sparkplugId || 'bundle'}`
  const isCommand = bundle?.kind === 'command'

  // One source for the block and the copy button. The install command is the server's text verbatim.
  const commands = isCommand
    ? bundle.command
    : [
      `cd ${folder}`,
      'docker compose up -d --build',
      'docker compose logs bootstrap',
    ].join('\n')

  const copyCommands = useCallback(async () => {
    const ok = await copyText(commands)
    setCopied(ok ? 'copied' : 'failed')
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the commands and copy them.', 'error')
  }, [commands, showToast])

  const askToReissue = useCallback(() => { setTyped(''); setError(null); setStep('confirm') }, [])
  // The other shape of the issue. It spends the token the shown one carries, so it asks first.
  const switchTo = useCallback((next) => { setMode(next); askToReissue() }, [askToReissue])

  // Declining must not throw away instructions that cannot be got back without issuing again.
  const backOut = useCallback(() => {
    if (step === 'confirm' && bundle) { setTyped(''); setError(null); setStep('ready') }
    else onClose()
  }, [step, bundle, onClose])

  let footer = null
  if (step === 'confirm') {
    footer = (
      <>
        <button className="btn btn-ghost" onClick={backOut} disabled={busy}>Cancel</button>
        <ActionButton
          pending={busy}
          pendingLabel="Issuing…"
          disabled={!confirmed}
          // `.btn-disabled` is the appearance; the attribute alone leaves a refusing button looking armed.
          className={`btn btn-primary${confirmed ? '' : ' btn-disabled'}`}
          onClick={generate}
          title={confirmed
            ? (mode === 'command' ? 'Mint a new token and show a fresh install command' : 'Mint a new token and download a fresh bundle')
            : 'Type the gateway name to enable this'}
        >
          {mode === 'command'
            ? <><IconCopy size={14} /> Issue Command</>
            : <><IconDownload size={14} /> Issue &amp; Download</>}
        </ActionButton>
      </>
    )
  } else if (error && !bundle) {
    footer = (
      <>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        {!error.deployment && (
          <ActionButton pending={busy} pendingLabel="Retrying…" onClick={generate}
                        title="Try issuing again">
            <IconRefreshCw size={14} /> Try again
          </ActionButton>
        )}
      </>
    )
  } else if (bundle) {
    footer = (
      <>
        <button className="btn btn-ghost" onClick={onClose}>Done</button>
        {isCommand
          ? (
            <button
              className="btn btn-ghost"
              onClick={() => switchTo('bundle')}
              title="For a machine that already has Docker, or one you set up by hand: mint a new token and download the bundle instead. This invalidates the command above."
            >
              <IconDownload size={14} /> Download the bundle instead
            </button>
          )
          : installer?.available && (
            <button
              className="btn btn-ghost"
              onClick={() => switchTo('command')}
              title="Mint a new token and show the one-line install command instead. This invalidates the bundle you already have."
            >
              <IconCopy size={14} /> Use the install command instead
            </button>
          )}
        <button
          className="btn btn-primary"
          onClick={askToReissue}
          title={isCommand
            ? 'Mint a new token and show a fresh command. This invalidates the one you already have.'
            : 'Mint a new token and download a fresh bundle. This invalidates the one you already have.'}
        >
          <IconRefreshCw size={14} /> {isCommand ? 'Re-issue Command' : 'Re-issue Bundle'}
        </button>
      </>
    )
  }

  return (
    <Modal
      title={<>Set up “{gateway.gateway_name}”</>}
      size="lg"
      onClose={backOut}
      error={error?.message}
      footer={footer}
    >
      {step === 'confirm' && (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Issue a new {mode === 'command' ? 'install command' : 'bundle'} for this gateway?</strong>
              <div>
                Only one token works at a time. Issuing this <strong>invalidates any bundle or
                command already issued</strong> for this gateway — an appliance started with the old one
                is refused at enrolment, with an error that cannot say why.
                {gateway.status === 'AWAITING_BIRTH' && (
                  <> This gateway has already enrolled, so this also revokes the broker credential
                    its appliance is holding.</>
                )}
              </div>
            </div>
          </div>

          <div className="form-group">
            {/* The name goes in the label, not in a placeholder, which looks like text already
                entered. */}
            <label className="form-label" htmlFor="gw-bundle-confirm">
              Type <span className="mono gateway-typed-name">{gateway.gateway_name}</span> to confirm
            </label>
            <input
              id="gw-bundle-confirm"
              className="form-control mono"
              autoFocus
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !busy) generate() }}
              aria-label={`Type ${gateway.gateway_name} to confirm`}
            />
          </div>
        </>
      )}

      {step === 'ready' && (
        <>
          {/* Reported in place, so the dialog does not shift when the issue resolves. */}
          {busy && !bundle && (
            <p className="form-hint">
              {mode === 'command' ? 'Minting the install command…' : 'Generating a bundle and starting the download…'}
            </p>
          )}

          {error?.deployment && !bundle && (
            <p className="form-hint">
              {error.details || 'The address an appliance would dial is not set on this deployment.'}
              {' '}The gateway exists and keeps its place in the list; set it up from its drawer once
              the deployment is configured. Host and Simulated gateways are unaffected.
            </p>
          )}

          {bundle && (
            <>
              {/* Amber while the clock runs, red once the token is dead. */}
              <div className={`callout ${expired ? 'callout-danger' : 'callout-warning'}`}>
                <IconShieldAlert size={14} className="callout-icon" />
                {expired ? (
                  <div>
                    <strong>This {isCommand ? 'command' : 'bundle'} has expired.</strong>
                    <div>
                      An appliance using it will be refused. Re-issue below — that invalidates the
                      expired one too{isCommand ? '.' : ', so delete the old folder rather than keeping both.'}
                    </div>
                  </div>
                ) : (
                  <div>
                    <strong>Valid for {formatCountdown(remaining)}</strong>
                    <div>
                      {isCommand
                        ? 'Paste it before the timer runs out. This is now the only command or bundle that works for this gateway — any earlier one has stopped working.'
                        : 'Start the appliance before the timer runs out. This is now the only bundle that works for this gateway — any earlier download has stopped working.'}
                    </div>
                  </div>
                )}
              </div>

              <div className="form-group">
                <div className="gateway-block-head">
                  <div className="form-label">
                    {isCommand ? 'Paste on the appliance, as a user with sudo' : 'On the appliance'}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={copyCommands}
                    title={isCommand ? 'Copy the command' : 'Copy all three commands'}
                  >
                    {copied === 'copied'
                      ? <><IconCheck size={12} /> Copied</>
                      : copied === 'failed'
                        ? <><IconShieldAlert size={12} /> Copy failed</>
                        : <><IconCopy size={12} /> {isCommand ? 'Copy Command' : 'Copy Commands'}</>}
                  </button>
                </div>
                <pre className={`mono gateway-code${isCommand ? ' gateway-code-wrap' : ''}`}>{commands}</pre>
                <div className="form-hint">
                  {isCommand
                    ? <>
                      On a fresh Ubuntu machine with a route to the platform. It {bundle.caPin
                        ? <>fetches the platform's root certificate, checks it against the pin <span className="mono">{bundle.caPin.slice(0, 12)}…</span> and installs it, then </>
                        : 'is served over plain HTTP, which only a development deployment allows; it then '}
                      installs Docker and the platform playbook, enrols, and prints the Node-RED editor
                      password <strong>once</strong>. Safe to run again until it has enrolled.
                    </>
                    : <>The last command prints the Node-RED editor password. It is shown <strong>once</strong>.</>}
                </div>
              </div>

              <p className="form-hint">
                Publishes as <span className="mono">{sparkplugId}</span>. Devices it announces arrive
                in the <strong>quarantine queue</strong> for approval — nothing needs pre-registering.
              </p>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

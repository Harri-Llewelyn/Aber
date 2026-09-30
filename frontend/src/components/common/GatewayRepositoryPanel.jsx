import React from 'react'
import { FORGE_ORGANISATION, GITEA_URL } from '../../constants'
import { IconAlertCircle, IconBookOpen, IconExternalLink, IconGitBranch, IconGitCompare } from './Icons'

/**
 * The address of a gateway's own repository in the forge. Derived, not stored: it is named from the
 * `sparkplug_id` (_shared/forge.ts) and lives in the organisation named in constants.js.
 */
export function gatewayRepositoryUrl(gateway) {
  return `${GITEA_URL}/${FORGE_ORGANISATION}/gateway-${gateway.sparkplug_id}`
}

/**
 * The forge's diff between what was approved and what the appliance reports it is running: `main`
 * against `appliance`. Two dots, the direct diff between the heads; three would list every file on
 * the branch as added.
 */
export function gatewayCompareUrl(gateway) {
  return `${gatewayRepositoryUrl(gateway)}/compare/main..appliance`
}

export function GatewayRepositoryPanel({ gateway, canOpenForge }) {
  // Nothing for a role the forge would refuse, rather than a disabled link.
  if (!canOpenForge) return null

  // A host-run gateway has no repository: one is created only when an appliance enrols. Shadow is
  // tested first because a shadow gateway is also simulated.
  if (gateway?.deployment === 'host') {
    let reason
    if (gateway.is_shadow) {
      reason = (
        <>
          A shadow gateway has no repository of its own. Playback publishes as it, replaying a
          capture, so there is no flow to edit.
        </>
      )
    } else if (gateway.is_simulated) {
      reason = (
        <>
          A simulated gateway has no repository of its own. Its readings are generated inside this
          stack rather than by an appliance. If a flow in this stack's own Node-RED generates them,
          edit it in the Node-RED editor.
        </>
      )
    } else {
      reason = (
        <>
          A host-run gateway has no repository of its own. Its connector runs in this stack's own
          Node-RED, which several host gateways can share — one <span className="mono">flows.json</span> is
          that whole instance. Edit it in the Node-RED editor instead.
        </>
      )
    }
    return (
      <div>
        <div className="form-label" style={{ margin: 0 }}>Repository</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          {reason}
        </div>
      </div>
    )
  }

  // Not enrolled yet: the repository is created when the appliance enrols, so every address 404s.
  if (!gateway?.enrolled_at) {
    return (
      <div>
        <div className="form-label" style={{ margin: 0 }}>Repository</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          This gateway has not enrolled yet, so it has no repository. One is created in the forge
          when the appliance enrols and sends the key it will read the repository with.
        </div>
      </div>
    )
  }

  // Enrolled is not the same as having a repository: creating it can be skipped (no forge, no
  // usable key) or fail, and `forge_repository_at` records that it happened.
  if (!gateway.forge_repository_at) {
    return (
      <div>
        <div className="form-label" style={{ margin: 0 }}>Repository</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          This gateway enrolled but has no repository in the forge. Either this deployment has no
          forge, or the appliance sent no key to read one with. Its flow is whatever was on the
          appliance when it enrolled, and nothing here can propose a change to it.
        </div>
      </div>
    )
  }

  const url = gatewayRepositoryUrl(gateway)

  // An archived gateway's repository is read-only in the forge. The links stay, since the flow,
  // incident log and wiki are still readable; only the paragraph above them changes.
  const archivedInForge = Boolean(gateway.forge_archived_at)

  return (
    <div>
      <div className="form-label" style={{ margin: 0 }}>Repository</div>
      {archivedInForge ? (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
          This gateway is archived, and so is its repository: the forge holds it read-only, badged
          as archived, with every branch, issue and wiki page kept — including{' '}
          <span className="mono">appliance</span>, the last thing the gateway reported. Nothing can
          be pushed or proposed until the gateway is restored, which takes the repository back out
          of the archive. Deleting it is a decision taken in the forge and never from here.
        </div>
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
          This gateway's flow lives in its own repository in the forge. To change what the appliance
          runs, open a pull request there with the <span className="mono">flows.json</span> exported
          from its Node-RED editor. Nothing is deployed until an administrator has approved it and it
          is merged to <span className="mono">main</span>, which the appliance then pulls. The
          appliance reports what it is running on its own <span className="mono">appliance</span> branch.
          Its issues are the gateway's incident log, and its wiki is for what a person needs to know
          and the appliance never reads.
        </div>
      )}
      {/* Real links, so middle-click and copy-link work. The compare view appears once the
          appliance has pushed its branch. */}
      <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {gateway.forge_appliance_sha && (
          <a
            className="btn btn-ghost"
            href={gatewayCompareUrl(gateway)}
            target="_blank"
            rel="noopener noreferrer"
            title="What the appliance reports it is running, against what was approved on main"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <IconGitCompare size={13} /> Running vs approved <IconExternalLink size={10} />
          </a>
        )}
        <a
          className="btn btn-ghost"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this gateway's repository in the forge"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <IconGitBranch size={13} /> Open in the forge <IconExternalLink size={10} />
        </a>
        <a
          className="btn btn-ghost"
          href={`${url}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this gateway's issues in the forge"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <IconAlertCircle size={13} /> Issues <IconExternalLink size={10} />
        </a>
        <a
          className="btn btn-ghost"
          href={`${url}/wiki`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this gateway's wiki in the forge"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <IconBookOpen size={13} /> Wiki <IconExternalLink size={10} />
        </a>
      </div>
    </div>
  )
}

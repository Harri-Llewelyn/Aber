import React from 'react'
import { FORGE_ORGANISATION, GITEA_URL } from '../../constants'
import { IconExternalLink, IconGitBranch } from './Icons'

/**
 * Where a gateway's flow lives, and where a change to it is proposed: its own repository in the
 * forge. This panel is a link, and the link is the whole of it.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS REPLACED A PROPOSAL DROPZONE, AND THE REPLACEMENT IS A REMOVAL RATHER THAN A RENAME.
 *
 * `FlowProposalPanel` took a `flows.json` here and had an edge function commit it to a branch and
 * open a pull request, because the forge had no login of its own and the proposer's name could only
 * reach it in a commit message. The forge has a door now -- the same two roles that review a flow
 * sign in with their dashboard identity (roadmap 7) -- so a pull request opened THERE, under the
 * author's own name, is the better record, and a second way to open one from here would be a second
 * path to the same state. The endpoint went with the dropzone.
 *
 * THE OPERATOR GATE WENT WITH IT, KNOWINGLY. The dropzone admitted Operators on the argument that a
 * review step whose proposals can only come from the roles that may merge them is a formality. The
 * roles that author flows on a plant are the two the forge admits, and a review whose proposals come
 * from managers and whose merges need an administrator's approval is still two privileges rather
 * than one. `main` is protected in every gateway repository; the forge enforces that, not this.
 *
 * ---------------------------------------------------------------------------------------------
 * THE PATH IS DERIVED, NOT FETCHED. The repository is named from the `sparkplug_id` in
 * _shared/forge.ts and lives in the organisation named there and in constants.js; nothing is
 * stored and nothing can drift, which is roadmap 9's argument against a pointer column. The
 * address is the forge's door, so an Operator who somehow followed it would meet the gateway's
 * 403 rather than a repository.
 */
export function gatewayRepositoryUrl(gateway) {
  return `${GITEA_URL}/${FORGE_ORGANISATION}/gateway-${gateway.sparkplug_id}`
}

export function GatewayRepositoryPanel({ gateway, canOpenForge }) {
  // NOTHING AT ALL FOR A ROLE THE FORGE WOULD REFUSE. Not a disabled link: that invites a request
  // for access that was never intended. Operators and Auditors land here.
  if (!canOpenForge) return null

  /**
   * A HOST-RUN GATEWAY HAS NO REPOSITORY OF ITS OWN, and the reason is worth stating rather than
   * hiding the panel silently. Its connector runs in THIS stack's Node-RED, and one instance can
   * carry several host gateways at once -- `flows.json` there is the whole instance, not one
   * gateway's. Repositories are created when an appliance enrols with a deploy key, and a host-run
   * gateway never enrols, so there is nothing to link to and nothing that should be.
   */
  if (gateway?.deployment === 'host') {
    return (
      <div>
        <div className="form-label" style={{ margin: 0 }}>Repository</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          A host-run gateway has no repository of its own. Its connector runs in this stack's own
          Node-RED, which several host gateways can share — one <span className="mono">flows.json</span> is
          that whole instance. Edit it in the Node-RED editor instead.
        </div>
      </div>
    )
  }

  const url = gatewayRepositoryUrl(gateway)

  return (
    <div>
      <div className="form-label" style={{ margin: 0 }}>Repository</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
        This gateway's flow lives in its own repository in the forge. To change what the appliance
        runs, open a pull request there with the <span className="mono">flows.json</span> exported
        from its Node-RED editor. Nothing is deployed until an administrator has approved it and it
        is merged to <span className="mono">main</span>, which the appliance then pulls.
      </div>
      {/* A REAL LINK, for the reason the Node-RED link is one: middle-click and copy-link work,
          and the usual next step is sending it to whoever is reviewing. */}
      <a
        className="btn btn-ghost"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open this gateway's repository in the forge"
        style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
      >
        <IconGitBranch size={13} /> Open in the forge <IconExternalLink size={10} />
      </a>
    </div>
  )
}

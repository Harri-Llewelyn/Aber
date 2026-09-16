import React from 'react'
import { FORGE_ORGANISATION, GITEA_URL } from '../../constants'
import { IconAlertCircle, IconBookOpen, IconExternalLink, IconGitBranch, IconGitCompare } from './Icons'

/**
 * Where a gateway's flow lives and where a change to it is proposed: its own repository in the
 * forge, reached by the forge's door (supabase/README.md, "The forge's door"). The path is derived,
 * not stored: the repository is named from the `sparkplug_id` in _shared/forge.ts and lives in the
 * organisation named there and in constants.js. Pull requests are opened in the forge under the
 * author's own name; `main` is protected there.
 */
export function gatewayRepositoryUrl(gateway) {
  return `${GITEA_URL}/${FORGE_ORGANISATION}/gateway-${gateway.sparkplug_id}`
}

/**
 * The forge's diff between what was approved and what the appliance reports it is running: `main`
 * against `appliance`, the branch only the appliance's deploy key writes (APPLIANCE_BRANCH in
 * _shared/forge.ts). Two dots, not three: the direct diff between the two heads, not the changes
 * since their common ancestor, which would list every file on the branch as added.
 */
export function gatewayCompareUrl(gateway) {
  return `${gatewayRepositoryUrl(gateway)}/compare/main..appliance`
}

export function GatewayRepositoryPanel({ gateway, canOpenForge }) {
  // NOTHING AT ALL FOR A ROLE THE FORGE WOULD REFUSE. Not a disabled link: that invites a request
  // for access that was never intended. Operators and Auditors land here.
  if (!canOpenForge) return null

  /**
   * A host-run gateway has no repository: its connector runs in this stack's Node-RED, whose
   * `flows.json` is the whole instance, and repositories are created only when an appliance enrols
   * with a deploy key. The panel says so rather than hiding.
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

  /**
   * A remote gateway that has never enrolled has no repository either: enroll-gateway creates it
   * from the deploy key the appliance sends when it redeems its bundle, so before that every
   * address here answers 404. `enrolled_at` is the column that records the redemption.
   */
  if (!gateway?.enrolled_at) {
    return (
      <div>
        <div className="form-label" style={{ margin: 0 }}>Repository</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          This gateway has not enrolled yet, so it has no repository. One is created in the forge
          when the appliance redeems its enrolment bundle and sends the key it will read the
          repository with.
        </div>
      </div>
    )
  }

  /**
   * Enrolled is not the same as having a repository. enroll-gateway sets `enrolled_at` in step 3
   * and creates the repository in step 4, and step 4 is non-fatal: it is skipped on a deployment
   * with no forge, skipped when the appliance sent no usable SSH key, and survives its own failure.
   * `forge_repository_at` records step 4 (0110), so this branch is the difference between a link
   * that works and four that answer 404 — or, with no forge deployed, four that point at whatever
   * address the frontend fell back to.
   */
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

  /**
   * Archiving a gateway archives its repository too (#197): forge-sweep marks it read-only in the
   * forge and records that here. The links stay — the whole point of archiving rather than
   * deleting is that the flow, the incident log and the wiki are still readable — so this replaces
   * the paragraph about proposing changes rather than the buttons under it.
   */
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
      {/* Real links, so middle-click and copy-link work. Three because the repository, its issues
          and its wiki are three different acts: change the flow, record an incident, write down
          what is known. A fourth, the compare view, once the appliance has reported: before its
          first push the branch does not exist and the forge would answer with a 404. */}
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

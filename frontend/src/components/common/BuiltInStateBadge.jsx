import React from 'react'
import { Badge } from './Badge'
import { IconAlertTriangle } from './Icons'
import { severityOf } from '../../utils/alertHistory'
import { plural } from '../../utils/format'

/**
 * A built-in alert's state, in words: how many instances are firing, and whether a rule could not be
 * evaluated, which says nothing of its condition. With neither it is "Not firing", never "OK": Aber
 * cannot see that Grafana evaluated the rule. `state` is one entry of builtInStates(), or null when
 * the open alerts could not be read, which says "Not known" rather than call a rule quiet.
 */
export function BuiltInStateBadge({ rule, state, size = 'sm' }) {
  if (!state) return <span className="cell-meta">Not known</span>
  if (!state.firing && !state.notEvaluated) return <span className="cell-meta">Not firing</span>
  return (
    <span className="built-in-state">
      {state.firing > 0 && (
        <Badge
          tone={severityOf(rule.severity).tone}
          size={size}
          title={`${plural(state.firing, 'instance')} of this rule ${state.firing === 1 ? 'is' : 'are'} firing now`}
        >
          {state.firing} firing
        </Badge>
      )}
      {state.notEvaluated > 0 && (
        <Badge
          tone="warning"
          size={size}
          icon={<IconAlertTriangle size={11} />}
          title="Grafana could not run this rule's query, so Aber cannot say whether its condition holds"
        >
          Could not be evaluated
        </Badge>
      )}
    </span>
  )
}

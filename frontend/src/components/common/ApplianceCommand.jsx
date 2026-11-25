import React, { useId } from 'react'
import { APPLIANCE_COMMANDS_HELP } from '../../utils/applianceCommands'
import { FieldError } from './FieldError'
import { HelpLink } from './HelpLink'
import { IconCheck, IconCopy } from './Icons'
import { Tooltip } from './Tooltip'
import { COPY_REFUSED, useCopy } from '../../hooks/useCopy'

/**
 * A command to run on a gateway's appliance, with its copy button: one block wherever the dashboard
 * shows one. The commands are utils/applianceCommands.js's, so a block and the help say one thing.
 *
 * @param {string} command What is shown and copied.
 * @param {string|null} [label] What the block is, over it. Null where the field it fills says so.
 * @param {string} [copyLabel] The copy button's words.
 * @param {string} [copyTip] The copy button's tooltip.
 * @param {boolean} [wrap] Whether a long line wraps in the block. One that does not scrolls there.
 * @param {boolean} [drawer] In a drawer: labelled as its fields are, with the copy button laid out as
 *   its other buttons are.
 * @param {node} [children] What to know before running it, under the block.
 * @param {Function} [showToast] Says in a drawer that a copy was refused. A dialog says it under the block.
 */
export function ApplianceCommand({
  command, label = 'On the appliance', copyLabel = 'Copy Command', copyTip = null, wrap = true,
  drawer = false, children = null, showToast,
}) {
  const { copied, refusal, copy } = useCopy()
  const errorId = useId()
  const refusedHere = drawer ? null : refusal

  const press = async () => {
    if (!(await copy(command)) && drawer) showToast?.(COPY_REFUSED, 'error')
  }

  const button = (
    <Tooltip text={copyTip}>
      <button
        className={drawer ? 'btn btn-ghost btn-sm context-action' : 'btn btn-ghost btn-sm'}
        onClick={press}
        aria-describedby={refusedHere ? errorId : undefined}
      >
        {copied ? <><IconCheck size={12} /> Copied</> : <><IconCopy size={12} /> {copyLabel}</>}
      </button>
    </Tooltip>
  )

  return (
    <div className={drawer ? 'appliance-command' : 'form-group'}>
      {drawer
        ? label && <div className="context-field-label">{label}</div>
        : (
          <div className="gateway-block-head">
            <div className="form-label">{label}</div>
            {button}
          </div>
        )}
      <pre className={`mono gateway-code${wrap ? ' gateway-code-wrap' : ''}`}>{command}</pre>
      {drawer && <div className="context-buttons">{button}</div>}
      {children && <div className="form-hint">{children}</div>}
      <FieldError id={errorId} error={refusedHere} />
    </div>
  )
}

/** The help page's section on the commands, as a block's hint links to it. */
export function ApplianceCommandsHelp() {
  return <HelpLink className="appliance-command-help" to={APPLIANCE_COMMANDS_HELP}>Commands on the appliance</HelpLink>
}

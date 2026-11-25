import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApplianceCommand, ApplianceCommandsHelp } from '../components/common/ApplianceCommand'
import * as commands from '../utils/applianceCommands'
import { HELP_FILES } from '../help/index'
import { helpTarget } from '../help/openHelp'
import { tooltipOf } from '../test/tooltips'

/**
 * A command to run on an appliance is one block, the setup dialog's and the drawer's, and its text
 * comes from one module. The documents are held to that text by drift check 546.
 */

let written
beforeEach(() => {
  written = []
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) } })
})
afterEach(() => vi.unstubAllGlobals())

const button = (name) => screen.getByRole('button', { name })

describe('the block', () => {
  it('shows the command, copies it as it stands, and says so on the button', async () => {
    render(<ApplianceCommand command={commands.CONVERGE_JOURNAL} />)

    expect(document.querySelector('pre').textContent).toBe(commands.CONVERGE_JOURNAL)
    fireEvent.click(button('Copy Command'))
    await waitFor(() => expect(button('Copied')).toBeInTheDocument())
    expect(written).toEqual([commands.CONVERGE_JOURNAL])
  })

  it('reports a refused copy under itself in a dialog, where a toast would be behind it', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('refused') }) } })
    const showToast = vi.fn()
    render(<ApplianceCommand command="true" showToast={showToast} />)

    fireEvent.click(button('Copy Command'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the clipboard')
    expect(button('Copy Command')).toHaveAccessibleDescription(/Could not reach the clipboard/)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('reports a refused copy in a toast from a drawer', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('refused') }) } })
    const showToast = vi.fn()
    render(<ApplianceCommand drawer command="true" showToast={showToast} />)

    fireEvent.click(button('Copy Command'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Could not reach the clipboard'), 'error'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('is laid out in a dialog as the install command is: label and button on one line, the code under it', () => {
    const { container } = render(
      <ApplianceCommand command="one" label="On the appliance" copyLabel="Copy Commands" copyTip="Copy all three commands" wrap={false}>
        A hint.
      </ApplianceCommand>
    )
    const block = container.firstChild
    expect(block).toHaveClass('form-group')
    expect([...block.children].map(c => c.className)).toEqual(['gateway-block-head', 'mono gateway-code', 'form-hint'])
    expect(block.firstChild.querySelector('.form-label').textContent).toBe('On the appliance')
    expect(button('Copy Commands').className).toBe('btn btn-ghost btn-sm')
    expect(tooltipOf(button('Copy Commands'))).toBe('Copy all three commands')
  })

  it('is laid out in a drawer as its fields and buttons are', () => {
    const { container } = render(<ApplianceCommand drawer command="one">A hint.</ApplianceCommand>)
    expect([...container.firstChild.children].map(c => c.className)).toEqual([
      'context-field-label', 'mono gateway-code gateway-code-wrap', 'context-buttons', 'form-hint'
    ])
    expect(button('Copy Command')).toHaveClass('context-action')
    expect(button('Copy Command').closest('.context-buttons')).not.toBeNull()
  })

  it('leaves the label out where the field it fills says it', () => {
    const { container } = render(<ApplianceCommand drawer label={null} command="one" />)
    expect(container.querySelector('.context-field-label')).toBeNull()
  })
})

describe('the commands', () => {
  it('joins two lines that each need sudo, so a password prompt cannot take the second for the password', () => {
    for (const [name, text] of Object.entries(commands).filter(([, v]) => typeof v === 'string')) {
      const lines = text.split('\n')
      lines.slice(1).forEach((line, i) => {
        if (line.startsWith('sudo ')) expect(lines[i], name).toMatch(/ &&$/)
      })
    }
  })

  it('takes the containers down before it removes the folders they keep mounted', () => {
    expect(commands.CLEAR_INSTALLED_ENROLMENT.split('\n')).toEqual([
      'sudo docker compose -p aber-gateway down -v &&',
      'sudo rm -rf /var/lib/aber-gateway/data /opt/aber-gateway',
    ])
  })

  it('starts a bundle in the folder it was unpacked to', () => {
    expect(commands.startBundle('aber-gateway-press')).toBe('cd aber-gateway-press\ndocker compose up -d --build\ndocker compose logs bootstrap')
  })
})

describe('the link to the help', () => {
  it('opens Commands on the appliance, which the help holds', () => {
    render(<ApplianceCommandsHelp />)
    const link = screen.getByRole('link', { name: 'Commands on the appliance' })
    const target = helpTarget(link.getAttribute('data-help'))
    const ids = new Set()
    const walk = (nodes = []) => nodes.forEach((n) => {
      if (n?.type === 'heading') ids.add(n.id)
      walk(n?.children)
      walk(n?.items)
    })
    walk(HELP_FILES[target.file].tokens)
    expect(target.file).toBe('site/remote-gateways')
    expect([...ids]).toContain(target.anchor)
  })
})

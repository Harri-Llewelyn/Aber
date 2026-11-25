import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplianceCommand } from '../components/common/ApplianceCommand'
import { CopyBlock, CopyField } from '../components/common/CopyField'
import { Modal } from '../components/common/Modal'
import { COPY_FEEDBACK_MS, COPY_REFUSED } from '../hooks/useCopy'
import { copyText } from '../utils/copyText'
import { SigningKeyModal } from '../components/modals/SigningKeyModal'
import { ServiceTokenModal } from '../components/modals/ServiceTokenModal'
import { ShowGatewayCredentialModal } from '../components/modals/ShowGatewayCredentialModal'
import { GatewayBundleModal } from '../components/modals/GatewayBundleModal'
import { api } from '../api'

/**
 * A value to copy is a CopyField: text in a box, a copy button whose icon is a tick for a moment, and
 * a refused copy said under that value alone. frontend/README.md, "A value to copy".
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn().mockResolvedValue([]), issueNotificationSigningKey: vi.fn(), mintServiceToken: vi.fn(),
      showGatewayCredential: vi.fn(), installCommand: vi.fn()
    }
  }
})

let written
let execCommand
/** The browser takes the copy, as it does in a secure context. */
const allow = () => vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) } })
/** No clipboard API (plain HTTP) and a fallback the browser refuses. */
const refuse = () => {
  vi.stubGlobal('navigator', {})
  document.execCommand = vi.fn(() => false)
}
beforeEach(() => {
  vi.clearAllMocks()
  written = []
  execCommand = document.execCommand
  allow()
})
afterEach(() => {
  document.execCommand = execCommand
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const button = (name) => screen.getByRole('button', { name })
const press = async (name) => { await act(async () => { fireEvent.click(button(name)) }) }

describe('CopyField', () => {
  it('is text in a box, named by its label and described by its hint, and no input', () => {
    render(<CopyField id="key" label="Signing Key" value="not-a-real-key" hint="Give it to the receiver." />)
    const value = screen.getByLabelText('Signing Key')
    expect(value.tagName).toBe('DIV')
    expect(value).toHaveClass('copy-field-value', 'mono')
    expect(value).toHaveTextContent('not-a-real-key')
    expect(value).toHaveAttribute('aria-readonly', 'true')
    expect(value).toHaveAccessibleDescription('Give it to the receiver.')
    expect(document.querySelector('input, textarea')).toBeNull()
  })

  it('copies the value as it stands, and shows a tick for a moment', async () => {
    render(<CopyField id="key" label="Signing Key" value="  spaced value " />)
    const icon = button('Copy signing key').querySelector('svg').outerHTML
    vi.useFakeTimers()
    await press('Copy signing key')
    expect(written).toEqual(['  spaced value '])
    expect(button('Copy signing key').querySelector('svg').outerHTML).not.toBe(icon)
    act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS) })
    expect(button('Copy signing key').querySelector('svg').outerHTML).toBe(icon)
  })

  it('names what it copies in the words given, where the label in lower case would be wrong', async () => {
    render(<CopyField id="node" label="Edge Node ID" value={1883} copyLabel="edge node ID" />)
    await press('Copy edge node ID')
    expect(written).toEqual(['1883'])
  })

  it('selects the whole value when it takes the focus, so it can be copied by hand', () => {
    render(<CopyField id="key" label="Signing Key" value="not-a-real-key" />)
    const value = screen.getByLabelText('Signing Key')
    expect(value).toHaveAttribute('tabindex', '0')
    act(() => value.focus())
    expect(window.getSelection().toString()).toBe('not-a-real-key')
  })

  it('shows a dash and copies nothing while there is no value, and says why in its warning', async () => {
    render(<CopyField id="host" label="Broker Address" value={undefined} warning="It could not be read." />)
    expect(screen.getByLabelText('Broker Address')).toHaveTextContent('—')
    expect(screen.getByLabelText('Broker Address')).toHaveAccessibleDescription('It could not be read.')
    expect(button('Copy broker address')).toBeDisabled()
    expect(button('Copy broker address')).toHaveClass('btn-disabled')
  })

  it('says a refused copy under its own value, until that value is copied', async () => {
    render(<>
      <CopyField id="a" label="Username" value="one" />
      <CopyField id="b" label="Password" value="two" hint="Shown once." />
    </>)
    refuse()
    await press('Copy password')
    expect(screen.getByRole('alert')).toHaveTextContent(COPY_REFUSED)
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(`Shown once. ${COPY_REFUSED}`)
    expect(button('Copy password')).toHaveAccessibleDescription(COPY_REFUSED)
    // The value is right: it is the copy that failed.
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByLabelText('Username')).not.toHaveAccessibleDescription()

    allow()
    await press('Copy username')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await press('Copy password')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

it.each([
  ['a value', () => <CopyField id="a" label="Username" value="one" />, 'Copy username'],
  ['a block', () => <CopyBlock text="one" head="Setup" copyLabel="Copy Setup">A long hint.</CopyBlock>, 'Copy Setup'],
  ['a command', () => <ApplianceCommand command="one">A long hint.</ApplianceCommand>, 'Copy Command'],
])('%s brings its refused copy into view, and a block says it before the hint', async (_, Shown, copy) => {
  const seen = []
  Element.prototype.scrollIntoView = function () { seen.push(this.textContent.trim()) }
  try {
    render(<Shown />)
    refuse()
    await press(copy)
    expect(seen).toEqual([COPY_REFUSED])
    const hint = screen.queryByText('A long hint.')
    if (hint) expect(screen.getByRole('alert').compareDocumentPosition(hint)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  } finally {
    delete Element.prototype.scrollIntoView
  }
})

describe('CopyBlock', () => {
  it('shows the text, copies it whole, and says a refusal under it', async () => {
    const text = 'line one\nline two'
    render(<CopyBlock text={text} head={<div className="form-label">Setup</div>} copyLabel="Copy Setup">Run both.</CopyBlock>)
    expect(document.querySelector('pre').textContent).toBe(text)
    await press('Copy Setup')
    expect(written).toEqual([text])
    expect(button('Copied')).toBeInTheDocument()

    refuse()
    await press('Copied')
    expect(screen.getByRole('alert')).toHaveTextContent(COPY_REFUSED)
    expect(button('Copy Setup')).toHaveAccessibleDescription(COPY_REFUSED)
  })
})

describe('over plain HTTP, where the browser has no clipboard API', () => {
  it('leaves the focus in the dialog, though the scratch field took it', async () => {
    render(<Modal title="Token" onClose={vi.fn()}><CopyField id="t" label="Token" value="not-a-real-token" /></Modal>)
    vi.stubGlobal('navigator', {})
    let copied = null
    document.execCommand = vi.fn(() => { copied = document.activeElement?.value ?? null; return true })
    // jsdom's select() does not take the focus; a browser's does.
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function () { this.focus() })
    await press('Copy token')
    expect(copied).toBe('not-a-real-token')
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    expect(document.querySelector('textarea')).toBeNull()
    vi.restoreAllMocks()
  })

  it('takes the scratch field away when the browser throws', async () => {
    vi.stubGlobal('navigator', {})
    document.execCommand = vi.fn(() => { throw new Error('not allowed') })
    expect(await copyText('x')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('the step that shows a secret once', () => {
  const GATEWAY = { gateway_id: 'g-1', gateway_name: 'Host Connector 2', sparkplug_id: 'gwy1', deployment: 'host' }
  const footer = () => [...document.querySelectorAll('.modal-actions button')]
  /** It ends with Done, its primary and its last button. */
  const endsWithDone = () => {
    expect(footer().at(-1)).toHaveTextContent(/^Done$/)
    expect(footer().at(-1)).toHaveClass('btn-primary')
    expect(footer().filter(b => b.className.includes('btn-primary'))).toHaveLength(1)
  }
  /** A refused copy is said under the value: no toast, and nothing in the dialog's error slot. */
  const saysRefusalUnderTheValue = async (label, name, showToast) => {
    refuse()
    showToast.mockClear()
    await press(name)
    expect(screen.getByRole('textbox', { name: label })).toHaveAccessibleDescription(expect.stringContaining(COPY_REFUSED))
    expect(document.querySelector('.modal-error')).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
  }

  it("a webhook's signing key", async () => {
    api.issueNotificationSigningKey.mockResolvedValue('not-a-real-key')
    const showToast = vi.fn()
    render(<SigningKeyModal onClose={vi.fn()} showToast={showToast} />)
    await press(/Issue Key/)
    endsWithDone()
    await saysRefusalUnderTheValue('Signing Key', 'Copy signing key', showToast)
  })

  it("a machine identity's token", async () => {
    api.mintServiceToken.mockResolvedValue({ token: 'not-a-real-token', jti: 'jti-1', expires_at: '2027-01-01T00:00:00Z' })
    const showToast = vi.fn()
    render(<ServiceTokenModal principal={{ principal_id: 'p-1', permissions: [] }} principalName="Reports" onClose={vi.fn()} showToast={showToast} />)
    await press(/Issue Token/)
    endsWithDone()
    await saysRefusalUnderTheValue('Token', 'Copy token', showToast)
  })

  it("a gateway's credential, shown again", async () => {
    api.showGatewayCredential.mockResolvedValue({ mqtt_username: 'gwy1', password: 'not-a-real-password' })
    const showToast = vi.fn()
    render(<ShowGatewayCredentialModal gateway={GATEWAY} onClose={vi.fn()} showToast={showToast} />)
    await press(/Show Credential/)
    endsWithDone()
    await saysRefusalUnderTheValue('Password', 'Copy password', showToast)
  })

  it("a gateway's setup, whose other buttons stand before Done", async () => {
    api.installCommand.mockResolvedValue({ command: 'sh install.sh', expiresAt: new Date(Date.now() + 60_000).toISOString(), sparkplugId: 'gwy1' })
    const onClose = vi.fn()
    const showToast = vi.fn()
    render(<GatewayBundleModal gateway={GATEWAY} onClose={onClose} showToast={showToast} installer={{ available: true }} />)
    await screen.findByRole('button', { name: 'Done' })
    endsWithDone()
    expect(footer().slice(0, -1).map(b => b.className)).toEqual(['btn btn-ghost', 'btn btn-ghost'])

    refuse()
    showToast.mockClear()
    await press('Copy Command')
    expect(screen.getByRole('alert')).toHaveTextContent(COPY_REFUSED)
    expect(document.querySelector('.modal-error')).toBeNull()
    expect(showToast).not.toHaveBeenCalled()
    await press('Done')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

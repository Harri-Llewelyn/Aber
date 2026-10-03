/**
 * The Cold Storage destination dialog. Two things matter most: it refuses to switch archiving on
 * until the destination is complete, and it writes only the settings that changed, through the
 * same call the Settings page uses, so each write is one audited row.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ColdStorageDestinationModal } from '../components/modals/ColdStorageDestinationModal'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { patchSetting: vi.fn(), setArchiveCredential: vi.fn() },
}))

const COMPLETE = {
  'archive.enabled': false,
  'archive.endpoint': 'https://s3.eu-west-2.amazonaws.com',
  'archive.region': 'eu-west-2',
  'archive.bucket': 'plant-history',
  'archive.access_key_id': 'AKIAEXAMPLE',
  'archive.path_style': false,
}

const SITE_KEY = 'broughton-7f3a9c21'

const open = (props = {}) => {
  const onSaved = vi.fn()
  render(
    <ColdStorageDestinationModal
      values={{}}
      siteKey={SITE_KEY}
      credentialSet={false}
      onSaved={onSaved}
      onClose={vi.fn()}
      {...props}
    />
  )
  return onSaved
}

const toggle = () => screen.getByRole('switch', { name: 'Archive telemetry before dropping it' })
const saveButton = () => screen.getByRole('button', { name: /^Save$/ })
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  vi.clearAllMocks()
  api.patchSetting.mockResolvedValue({})
  api.setArchiveCredential.mockResolvedValue(true)
})

describe('switching archiving on', () => {
  it('refuses on while the destination is incomplete, and says why in text beside the switch', () => {
    open()
    expect(toggle()).toBeDisabled()
    expect(toggle()).not.toBeChecked()
    // Text on the page, not only a tooltip, and tied to the switch for a screen reader.
    const reason = screen.getByText(/Still to set:/)
    expect(reason.textContent).toMatch(/S3 endpoint/)
    expect(reason.textContent).toMatch(/the secret access key/)
    expect(toggle()).toHaveAccessibleDescription(/S3 bucket/)
  })

  it('allows on once every field, the secret and the site key are there', () => {
    open()
    type('S3 endpoint', 'https://s3.eu-west-2.amazonaws.com')
    type('S3 region', 'eu-west-2')
    type('S3 bucket', 'plant-history')
    type('S3 access key ID', 'AKIAEXAMPLE')
    expect(toggle()).toBeDisabled()
    type('Secret access key', 'wJalrXUtnFEMI')
    expect(toggle()).toBeEnabled()
    expect(screen.queryByText(/Still to set:/)).toBeNull()
  })

  it('counts a stored secret, and still refuses without the site key fixed at install', () => {
    open({ values: COMPLETE, credentialSet: true, siteKey: '' })
    expect(toggle()).toBeDisabled()
    expect(screen.getByText(/Still to set:/).textContent).toMatch(/site key/)
  })

  it('lets archiving that is on with half a destination be switched off, and saves nothing else until then', async () => {
    const onSaved = open({ values: { 'archive.enabled': true, 'archive.endpoint': 'https://minio:9000' } })
    expect(toggle()).toBeChecked()
    expect(toggle()).toBeEnabled()
    // On with half a destination cannot be saved as it stands.
    type('S3 region', 'eu-west-2')
    expect(saveButton()).toBeDisabled()

    fireEvent.click(toggle())
    expect(saveButton()).toBeEnabled()
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // Off is written before anything else.
    expect(api.patchSetting.mock.calls).toEqual([['archive.enabled', false], ['archive.region', 'eu-west-2']])
  })

  it('writes on last, after the destination and the secret', async () => {
    const onSaved = open({ values: COMPLETE, credentialSet: false })
    type('Secret access key', '  wJalrXUtnFEMI  ')
    fireEvent.click(toggle())
    type('S3 region', 'eu-west-1')
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(api.patchSetting.mock.calls).toEqual([['archive.region', 'eu-west-1'], ['archive.enabled', true]])
    expect(api.setArchiveCredential).toHaveBeenCalledWith('wJalrXUtnFEMI')
    expect(api.setArchiveCredential.mock.invocationCallOrder[0])
      .toBeLessThan(api.patchSetting.mock.invocationCallOrder[1])
  })
})

describe('saving', () => {
  it('writes only the rows that changed', async () => {
    const onSaved = open({ values: COMPLETE, credentialSet: true })
    type('S3 bucket', 'plant-history-2')
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(api.patchSetting).toHaveBeenCalledTimes(1)
    expect(api.patchSetting).toHaveBeenCalledWith('archive.bucket', 'plant-history-2')
    // An empty secret field keeps the stored key.
    expect(api.setArchiveCredential).not.toHaveBeenCalled()
  })

  it('offers no Save while nothing has changed, and whitespace is not a key', () => {
    open({ values: COMPLETE, credentialSet: true })
    expect(saveButton()).toBeDisabled()
    type('Secret access key', '   ')
    expect(saveButton()).toBeDisabled()
    type('S3 region', 'eu-west-2 ')
    // A trailing space is the same value: nothing to write.
    expect(saveButton()).toBeDisabled()
  })

  it('keeps the typed key and shows the refusal in the dialog when a write fails', async () => {
    api.setArchiveCredential.mockRejectedValue(new Error('Only an Administrator can set the archive credential'))
    const onSaved = open({ values: COMPLETE })
    type('Secret access key', 'wJalrXUtnFEMI')
    fireEvent.click(saveButton())
    await waitFor(() => expect(screen.getByText(/Only an Administrator/)).toBeInTheDocument())
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Secret access key').value).toBe('wJalrXUtnFEMI')
  })
})

describe('what it shows', () => {
  it('never holds the stored secret: the field is a password field and starts empty', () => {
    open({ values: COMPLETE, credentialSet: true })
    const secret = screen.getByLabelText('Secret access key')
    expect(secret).toHaveAttribute('type', 'password')
    expect(secret.value).toBe('')
    expect(secret).toHaveAttribute('placeholder', 'Stored. Leave empty to keep it')
  })

  it('shows the site key read-only, and the destination as something to copy', () => {
    open({ values: COMPLETE })
    expect(screen.getByLabelText('Site key')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Site key')).toHaveValue(SITE_KEY)
    expect(screen.getByRole('button', { name: /copy destination/i })).toHaveAccessibleName(
      /https:\/\/s3\.eu-west-2\.amazonaws\.com\/plant-history\/site=broughton-7f3a9c21\//,
    )
  })

  it('says what is lost while archiving is off', () => {
    open({ values: COMPLETE })
    expect(screen.getByText(/dropped and cannot be recovered/)).toBeInTheDocument()
  })
})

/**
 * The field every foreign credential is typed into. What has to hold: a stored value is never
 * shown, not even masked; replacing one asks first and a first set does not; the dialog's save
 * writes only what was typed; and a refusal (403) is named as one, with what was typed kept.
 */
import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { CredentialField, useCredential } from '../components/common/CredentialField'

/** A dialog's shape: the field, and a Save that commits it and reports what it threw. */
function Harness({ stored, write }) {
  const credential = useCredential({ stored, write, label: 'the secret access key' })
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)
  const save = async () => {
    setError(null)
    try { setSaved(await credential.commit()) } catch (err) { setError(err.message) }
  }
  return (
    <>
      <CredentialField id="key" credential={credential} consequence="If the new one is wrong, the next copy fails." />
      <button onClick={save}>Save</button>
      {error && <p role="alert">{error}</p>}
      {saved !== null && <p data-testid="saved">{String(saved)}</p>}
    </>
  )
}

const open = ({ stored = false, write = vi.fn().mockResolvedValue(true) } = {}) => {
  render(<Harness stored={stored} write={write} />)
  return write
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))

describe('a first set', () => {
  it('goes straight to the field, with no question', () => {
    open()
    const field = screen.getByLabelText('Secret access key')
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('placeholder', 'Not set')
    expect(screen.queryByRole('button', { name: 'Replace It' })).toBeNull()
    expect(screen.queryByText(/already stored/)).toBeNull()
  })

  it('writes the trimmed key on save, and then reads as stored', async () => {
    const write = open()
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: '  wJalrXUtnFEMI  ' } })
    save()
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('true'))
    expect(write).toHaveBeenCalledWith('wJalrXUtnFEMI')
    expect(document.querySelector('input')).toBeNull()
    expect(screen.getByText('Stored in the vault')).toBeInTheDocument()
  })

  it('writes nothing for an empty or blank field', async () => {
    const write = open()
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: '   ' } })
    save()
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('false'))
    expect(write).not.toHaveBeenCalled()
  })
})

describe('a stored key', () => {
  it('is never shown, not even as a masked field', () => {
    const { container } = render(<Harness stored write={vi.fn()} />)
    expect(screen.getByText('Stored in the vault')).toBeInTheDocument()
    expect(container.querySelector('input')).toBeNull()
    expect(screen.getByRole('group', { name: 'Secret access key' })).toBeInTheDocument()
  })

  it('is kept when the dialog saves without replacing it', async () => {
    const write = open({ stored: true })
    save()
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('false'))
    expect(write).not.toHaveBeenCalled()
  })

  it('asks before replacing, saying what is lost, and Keep It goes back', () => {
    open({ stored: true })
    fireEvent.click(screen.getByRole('button', { name: 'Replace Key' }))
    const question = screen.getByTestId('key-replace')
    expect(question).toHaveTextContent('A key is already stored')
    expect(question).toHaveTextContent('If the new one is wrong, the next copy fails.')
    expect(question).toHaveTextContent('cannot be recovered')
    // No field until the question is answered.
    expect(document.querySelector('input')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Keep It' }))
    expect(screen.getByText('Stored in the vault')).toBeInTheDocument()
  })

  it('takes a new key once the question is answered, focused, and writes it on save', async () => {
    const write = open({ stored: true })
    fireEvent.click(screen.getByRole('button', { name: 'Replace Key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace It' }))
    const field = screen.getByLabelText('Secret access key')
    expect(field).toHaveFocus()
    expect(field.value).toBe('')
    expect(field).toHaveAttribute('placeholder', 'The new key')
    fireEvent.change(field, { target: { value: 'second-key' } })
    save()
    await waitFor(() => expect(write).toHaveBeenCalledWith('second-key'))
    expect(await screen.findByText('Stored in the vault')).toBeInTheDocument()
  })

  it('drops what was typed when the person keeps the stored key after all', async () => {
    const write = open({ stored: true })
    fireEvent.click(screen.getByRole('button', { name: 'Replace Key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace It' }))
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'typo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep the Stored Key' }))
    save()
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('false'))
    expect(write).not.toHaveBeenCalled()
  })
})

describe('a refusal', () => {
  it('names a 403 as one, and keeps what was typed', async () => {
    const write = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    open({ stored: true, write })
    fireEvent.click(screen.getByRole('button', { name: 'Replace Key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Replace It' }))
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'not-mine' } })
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an Administrator can set the secret access key. The stored one is unchanged.')
    expect(screen.getByLabelText('Secret access key').value).toBe('not-mine')
  })

  it('says nothing was stored when the refused write was the first', async () => {
    open({ write: vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 })) })
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'not-mine' } })
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was stored.')
  })

  it('passes any other failure through in its own words', async () => {
    open({ write: vi.fn().mockRejectedValue(new Error('the vault did not answer')) })
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'k' } })
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('the vault did not answer')
  })
})

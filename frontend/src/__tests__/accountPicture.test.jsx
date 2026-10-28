/**
 * A person's own picture (0213): the square the page shrinks a photo to before upload, and that
 * nothing of the original file but its pixels goes up; the account mark's fallback order (picture,
 * then initials from the display name, then the icon); the Picture row on Profile > Account, with
 * its preview, Save, Discard and Remove; the hook that holds the blob URL; and the calls to Storage,
 * which ask it nothing for a person with no picture.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabaseClient', () => {
  const storageBucket = { download: vi.fn(), upload: vi.fn(), remove: vi.fn() }
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return {
    SUPABASE_URL: 'https://api.site.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: {
      auth: { getSession: vi.fn(() => new Promise(() => {})) },
      from: vi.fn(() => query),
      rpc: vi.fn(),
      storage: { from: vi.fn(() => storageBucket) },
      __query: query,
      __bucket: storageBucket,
    },
  }
})

import { supabase } from '../lib/supabaseClient'
import { api } from '../api'
import { AccountAvatar } from '../components/common/AccountAvatar'
import { ProfileTab } from '../components/tabs/ProfileTab'
import { useOwnPicture } from '../hooks/useOwnPicture'
import {
  PICTURE_BUCKET, PICTURE_SIZE, PICTURE_STORED_MAX_BYTES, PICTURE_TYPES, centredSquare, initialsOf,
  pictureFileProblem, picturePath, shrinkPicture,
} from '../utils/picture'

const OWNER = '00000000-0000-4000-8000-0000000d1024'
const bucket = supabase.__bucket
const query = supabase.__query

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A photo as a phone takes one: JPEG bytes carrying an EXIF block with a GPS position. */
const photo = (type = 'image/jpeg', size = null) => {
  const bytes = 'FFD8 Exif\0\0 GPSLatitude 52.4153 GPSLongitude -4.0829 FFD9'
  const file = new File([bytes], `photo.${type.split('/')[1]}`, { type })
  if (size !== null) Object.defineProperty(file, 'size', { value: size })
  return file
}

/**
 * A canvas that records what is drawn and encodes to the type it is asked for, unless that type is
 * one this "browser" cannot encode, when it gives a PNG as toBlob() does.
 */
function fakeCanvas({ encodes = ['image/webp', 'image/jpeg'] } = {}) {
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: null, imageSmoothingQuality: null }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((done, type) => {
      const made = encodes.includes(type) ? type : 'image/png'
      done(new Blob([`pixels as ${made}`], { type: made }))
    }),
  }
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => (tag === 'canvas' ? canvas : create(tag, ...rest)))
  return { canvas, context }
}

function decodesAs(width, height) {
  const bitmap = { width, height, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap)))
  return bitmap
}

describe('what the picker takes', () => {
  it('takes the types the bucket admits, up to 10 MB', () => {
    expect(PICTURE_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    for (const type of PICTURE_TYPES) expect(pictureFileProblem(photo(type))).toBeNull()
    expect(pictureFileProblem(photo('image/jpeg', 10 * 1024 * 1024))).toBeNull()
  })

  it('refuses an SVG, a GIF, a file over 10 MB and no file, saying why', () => {
    expect(pictureFileProblem(photo('image/svg+xml'))).toBe('A picture is a PNG, JPEG or WebP file.')
    expect(pictureFileProblem(photo('image/gif'))).toBe('A picture is a PNG, JPEG or WebP file.')
    expect(pictureFileProblem(photo('image/jpeg', 10 * 1024 * 1024 + 1))).toMatch(/larger than 10 MB/)
    expect(pictureFileProblem(null)).toBe('Choose a picture.')
  })

  it('names the one object the policies admit its owner to', () => {
    expect(PICTURE_BUCKET).toBe('avatars')
    expect(picturePath(OWNER)).toBe(`${OWNER}/avatar`)
  })
})

describe('the square that is uploaded', () => {
  it('is the largest centred square, landscape or portrait', () => {
    expect(centredSquare(4000, 3000)).toEqual({ sx: 500, sy: 0, side: 3000 })
    expect(centredSquare(3000, 4000)).toEqual({ sx: 0, sy: 500, side: 3000 })
    expect(centredSquare(257, 256)).toEqual({ sx: 0, sy: 0, side: 256 })
    expect(centredSquare(300, 300)).toEqual({ sx: 0, sy: 0, side: 300 })
  })

  it('crops a centred square, scales it to 256x256 and encodes WebP', async () => {
    const bitmap = decodesAs(4032, 3024)
    const { canvas, context } = fakeCanvas()
    const blob = await shrinkPicture(photo())
    expect([canvas.width, canvas.height]).toEqual([PICTURE_SIZE, PICTURE_SIZE])
    expect(PICTURE_SIZE).toBe(256)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 504, 0, 3024, 3024, 0, 0, 256, 256)
    expect(blob.type).toBe('image/webp')
    expect(canvas.toBlob).toHaveBeenCalledTimes(1)
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('encodes JPEG where the browser gives something other than WebP, on white', async () => {
    decodesAs(800, 1200)
    const { canvas, context } = fakeCanvas({ encodes: ['image/jpeg'] })
    const blob = await shrinkPicture(photo('image/png'))
    expect(blob.type).toBe('image/jpeg')
    expect(canvas.toBlob.mock.calls.map(c => c[1])).toEqual(['image/webp', 'image/jpeg'])
    expect(context.fillStyle).toBe('#ffffff')
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 256, 256)
    expect(context.drawImage.mock.calls[0].slice(1)).toEqual([0, 200, 800, 800, 0, 0, 256, 256])
  })

  it('uploads only what the canvas drew: the photo\'s EXIF and GPS position are gone', async () => {
    decodesAs(4032, 3024)
    fakeCanvas()
    const file = photo()
    const blob = await shrinkPicture(file)
    expect(blob).not.toBe(file)
    const sent = await blob.text()
    expect(sent).toBe('pixels as image/webp')
    expect(sent).not.toMatch(/Exif|GPS/)
    expect(blob.size).toBeLessThanOrEqual(PICTURE_STORED_MAX_BYTES)
  })

  it('refuses a file it cannot read, or one the picker would refuse, with a sentence', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('InvalidStateError'))))
    fakeCanvas()
    await expect(shrinkPicture(photo())).rejects.toThrow('The browser could not read that picture. Choose another.')
    await expect(shrinkPicture(photo('image/gif'))).rejects.toThrow('A picture is a PNG, JPEG or WebP file.')
  })

  it('refuses where the browser can encode neither WebP nor JPEG', async () => {
    decodesAs(300, 300)
    fakeCanvas({ encodes: [] })
    await expect(shrinkPicture(photo())).rejects.toThrow(/cannot shrink a picture/)
  })
})

describe('initials', () => {
  it('are the first letter of the first and the last word, upper-cased', () => {
    expect(initialsOf('Owain Operator')).toBe('OO')
    expect(initialsOf('ada lovelace')).toBe('AL')
    expect(initialsOf('Mary Ann Evans')).toBe('ME')
    expect(initialsOf('  Harri   Llewelyn  ')).toBe('HL')
  })

  it('are one letter for one word, and none for no name', () => {
    expect(initialsOf('Ada')).toBe('A')
    expect(initialsOf('')).toBe('')
    expect(initialsOf('   ')).toBe('')
    expect(initialsOf(null)).toBe('')
    expect(initialsOf(undefined)).toBe('')
  })

  it('skip what is not a letter, and keep a letter whole', () => {
    expect(initialsOf('"Dai" (Night shift)')).toBe('DS')
    expect(initialsOf('— Ffion')).toBe('F')
    expect(initialsOf('Éowyn Ödegaard')).toBe('ÉÖ')
    expect(initialsOf('🙂')).toBe('')
  })
})

describe('the account mark', () => {
  const mark = () => document.querySelector('.user-avatar')

  it('shows the picture first, with empty alt text, hidden from assistive technology', () => {
    render(<AccountAvatar pictureUrl="blob:picture-1" displayName="Owain Operator" />)
    const img = mark().querySelector('img')
    expect(img).toHaveAttribute('src', 'blob:picture-1')
    expect(img).toHaveAttribute('alt', '')
    expect(mark()).toHaveAttribute('aria-hidden', 'true')
    expect(mark()).toHaveAttribute('data-avatar', 'picture')
    expect(mark()).toHaveClass('user-avatar', 'user-avatar-picture')
    expect(mark()).not.toHaveTextContent('OO')
  })

  it('shows the initials of the display name with no picture, then the icon with no name', () => {
    const { rerender } = render(<AccountAvatar pictureUrl={null} displayName="Owain Operator" />)
    expect(mark()).toHaveAttribute('data-avatar', 'initials')
    expect(mark()).toHaveTextContent('OO')
    expect(mark().querySelector('img, svg')).toBeNull()
    rerender(<AccountAvatar pictureUrl={null} displayName={null} />)
    expect(mark()).toHaveAttribute('data-avatar', 'icon')
    expect(mark().querySelector('svg')).not.toBeNull()
    expect(mark()).toHaveTextContent('')
  })

  it('falls back when the browser cannot draw the picture, and tries a new one', () => {
    const { rerender } = render(<AccountAvatar pictureUrl="blob:broken" displayName="Owain Operator" />)
    fireEvent.error(mark().querySelector('img'))
    expect(mark()).toHaveAttribute('data-avatar', 'initials')
    rerender(<AccountAvatar pictureUrl="blob:picture-2" displayName="Owain Operator" />)
    expect(mark()).toHaveAttribute('data-avatar', 'picture')
  })
})

describe('Profile > Account > Picture', () => {
  const renderProfile = (props = {}) => {
    const handlers = { onSavePicture: vi.fn(() => Promise.resolve('blob:saved')), onRemovePicture: vi.fn(() => Promise.resolve()) }
    render(<ProfileTab email="operator@site.test" userRole="Operator" displayName="Owain Operator" theme="dark"
      sidebarMode="hover" {...handlers} {...props} />)
    return handlers
  }
  const row = () => screen.getByText('Picture', { selector: '.setting-label' }).closest('tr')
  const input = () => row().querySelector('input[type="file"]')
  const button = (name) => screen.queryByRole('button', { name })

  beforeEach(() => {
    decodesAs(1200, 900)
    fakeCanvas()
  })

  it('sits after Display name, says who sees it, and offers a picture of the allowed types', () => {
    renderProfile()
    const labels = [...document.querySelectorAll('.setting-label')].map(l => l.textContent)
    expect(labels.slice(0, 3)).toEqual(['Email address', 'Display name', 'Picture'])
    expect(row()).toHaveTextContent('Nobody else sees it.')
    expect(input()).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp')
    expect(button(/Choose Picture/)).toBeInTheDocument()
    expect(button(/^Remove$/)).toBeNull()
    expect(row().querySelector('.user-avatar')).toHaveAttribute('data-avatar', 'initials')
  })

  it('previews the shrunk picture before Save, and Save uploads it', async () => {
    const { onSavePicture } = renderProfile()
    fireEvent.change(input(), { target: { files: [photo()] } })
    await waitFor(() => expect(row().querySelector('.user-avatar')).toHaveAttribute('data-avatar', 'picture'))
    expect(row()).toHaveTextContent('Not saved yet')
    expect(onSavePicture).not.toHaveBeenCalled()
    fireEvent.click(button('Save'))
    await waitFor(() => expect(onSavePicture).toHaveBeenCalledTimes(1))
    const uploaded = onSavePicture.mock.calls[0][0]
    expect(uploaded.type).toBe('image/webp')
    await waitFor(() => expect(button('Save')).toBeNull())
  })

  it('Discard drops the preview and uploads nothing', async () => {
    const { onSavePicture } = renderProfile()
    fireEvent.change(input(), { target: { files: [photo()] } })
    await waitFor(() => expect(button('Save')).toBeInTheDocument())
    fireEvent.click(button(/Discard/))
    expect(row().querySelector('.user-avatar')).toHaveAttribute('data-avatar', 'initials')
    expect(onSavePicture).not.toHaveBeenCalled()
  })

  it('refuses a file of another type before shrinking it, saying why', async () => {
    renderProfile()
    fireEvent.change(input(), { target: { files: [photo('image/gif')] } })
    expect(await screen.findByRole('status')).toHaveTextContent('A picture is a PNG, JPEG or WebP file.')
    expect(createImageBitmap).not.toHaveBeenCalled()
    expect(button('Save')).toBeNull()
  })

  it('shows the saved picture, and Remove deletes it', async () => {
    const { onRemovePicture } = renderProfile({ pictureUrl: 'blob:saved-1' })
    expect(row().querySelector('img')).toHaveAttribute('src', 'blob:saved-1')
    fireEvent.click(button(/^Remove$/))
    await waitFor(() => expect(onRemovePicture).toHaveBeenCalledTimes(1))
  })

  it('says why a save failed, and keeps the preview to try again', async () => {
    const onSavePicture = vi.fn(() => Promise.reject(new Error('Your picture was not uploaded.')))
    renderProfile({ onSavePicture })
    fireEvent.change(input(), { target: { files: [photo()] } })
    await waitFor(() => expect(button('Save')).toBeInTheDocument())
    fireEvent.click(button('Save'))
    expect(await screen.findByRole('status')).toHaveTextContent('Your picture was not uploaded.')
    expect(button('Save')).toBeInTheDocument()
    expect(onSavePicture).toHaveBeenCalledTimes(1)
  })

  it('has no picture for a machine identity', () => {
    renderProfile({ email: null })
    expect(row()).toHaveTextContent('None: a machine identity has no picture')
    expect(input()).toBeNull()
  })
})

describe('the picture the page holds', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'revokeObjectURL')
  })

  it('reads it once for the person, and revokes each URL it replaces', async () => {
    vi.spyOn(api, 'ownPictureUrl').mockResolvedValue('blob:first')
    vi.spyOn(api, 'saveOwnPicture').mockResolvedValue('blob:second')
    vi.spyOn(api, 'removeOwnPicture').mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() => useOwnPicture(OWNER))
    await waitFor(() => expect(result.current.pictureUrl).toBe('blob:first'))
    expect(api.ownPictureUrl).toHaveBeenCalledWith(OWNER)

    await act(() => result.current.savePicture(new Blob(['x'], { type: 'image/webp' })))
    expect(result.current.pictureUrl).toBe('blob:second')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first')

    await act(() => result.current.removePicture())
    expect(result.current.pictureUrl).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second')
    unmount()
  })

  it('asks nothing for an identity with no person, and shows none when the read fails', async () => {
    const read = vi.spyOn(api, 'ownPictureUrl').mockRejectedValue(new Error('offline'))
    const { result, rerender } = renderHook(({ id }) => useOwnPicture(id), { initialProps: { id: null } })
    expect(read).not.toHaveBeenCalled()
    rerender({ id: OWNER })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(result.current.pictureUrl).toBeNull()
  })
})

describe('the calls to Storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.select.mockReturnValue(query)
    query.eq.mockReturnValue(query)
  })

  it('downloads nothing for a person with no picture', async () => {
    query.maybeSingle.mockResolvedValue({ data: null, error: null })
    expect(await api.ownPictureUrl(OWNER)).toBeNull()
    expect(supabase.from).toHaveBeenCalledWith('person_profiles')
    expect(query.eq).toHaveBeenCalledWith('user_id', OWNER)
    expect(bucket.download).not.toHaveBeenCalled()
  })

  it('downloads their own object with the session, uncached, as a blob URL', async () => {
    query.maybeSingle.mockResolvedValue({ data: { avatar_path: `${OWNER}/avatar` }, error: null })
    bucket.download.mockResolvedValue({ data: new Blob(['p'], { type: 'image/webp' }), error: null })
    const url = await api.ownPictureUrl(OWNER)
    expect(url).toMatch(/^blob:/)
    expect(supabase.storage.from).toHaveBeenCalledWith('avatars')
    expect(bucket.download).toHaveBeenCalledWith(`${OWNER}/avatar`, {}, { cache: 'no-store' })
  })

  it('shows no picture, not an error, when the column names a missing object', async () => {
    query.maybeSingle.mockResolvedValue({ data: { avatar_path: `${OWNER}/avatar` }, error: null })
    bucket.download.mockResolvedValue({ data: null, error: { message: 'Object not found' } })
    expect(await api.ownPictureUrl(OWNER)).toBeNull()
  })

  it('uploads over the one object, then records it', async () => {
    bucket.upload.mockResolvedValue({ data: { path: `${OWNER}/avatar` }, error: null })
    supabase.rpc.mockResolvedValue({ data: `${OWNER}/avatar`, error: null })
    const blob = new Blob(['p'], { type: 'image/webp' })
    expect(await api.saveOwnPicture(OWNER, blob)).toMatch(/^blob:/)
    expect(bucket.upload).toHaveBeenCalledWith(`${OWNER}/avatar`, blob, { upsert: true, contentType: 'image/webp' })
    expect(supabase.rpc).toHaveBeenCalledWith('set_own_picture', { p_present: true })
    expect(bucket.upload.mock.invocationCallOrder[0]).toBeLessThan(supabase.rpc.mock.invocationCallOrder[0])
  })

  it('records nothing when the upload is refused, and says why', async () => {
    bucket.upload.mockResolvedValue({ data: null, error: { message: 'new row violates row-level security policy' } })
    await expect(api.saveOwnPicture(OWNER, new Blob(['p'], { type: 'image/webp' }))).rejects.toThrow(/holds no role/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('deletes the object, then records none', async () => {
    bucket.remove.mockResolvedValue({ data: [], error: null })
    supabase.rpc.mockResolvedValue({ data: null, error: null })
    await api.removeOwnPicture(OWNER)
    expect(bucket.remove).toHaveBeenCalledWith([`${OWNER}/avatar`])
    expect(supabase.rpc).toHaveBeenCalledWith('set_own_picture', { p_present: false })
  })
})

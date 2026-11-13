import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { declaration } from '../test/themeColours'
import { Model3DUploader } from '../components/common/Model3DUploader'

/**
 * Where the Expand button and the 3D model dialog's parts sit. Expand is in the top-right corner of
 * the plan it enlarges (one rule, `.expand-corner`); the dialog's file row holds the name and size
 * on the left and Download, Replace and Remove on the right; the viewer and the empty drop zone
 * take the dialog's body. jsdom lays nothing out, so the geometry is read from App.css.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { uploadDeviceModel: vi.fn(), removeDeviceModel: vi.fn() },
    model3dPublicUrl: (p) => (p ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${p}` : null),
    model3dDownloadUrl: (p) => (p ? `http://localhost:54321/storage/v1/object/public/asset-3d-models/${p}?download=x` : null)
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({}) } },
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_GATEWAY_KEY: 'anon'
}))

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '..', 'App.css'), 'utf8')
const prop = (selector, name) => {
  const value = declaration(APP_CSS, selector, name)
  if (value === null) throw new Error(`no ${name} for ${selector} in App.css`)
  return value
}

const DEVICE = { asset_id: 'dev-1', asset_name: 'CNC_01', model_3d_path: 'dev-1/cnc.glb' }

describe('the Expand button\'s corner', () => {
  it('is one rule: the top-right corner of its frame, on the surface, above the pins', () => {
    expect(prop('.expand-frame', 'position')).toBe('relative')
    expect(prop('.btn-icon.expand-corner', 'position')).toBe('absolute')
    expect(prop('.btn-icon.expand-corner', 'top')).toBe('6px')
    expect(prop('.btn-icon.expand-corner', 'right')).toBe('6px')
    expect(prop('.btn-icon.expand-corner', 'background')).toBe('var(--bg-surface)')
    expect(Number(prop('.btn-icon.expand-corner', 'z-index'))).toBeGreaterThan(Number(prop('.area-plan-pin', 'z-index')))
  })

  it('leaves no rule for the places it used to sit', () => {
    for (const gone of [/\.model-viewer-expand(?![\w-])/, /\.model-viewer-holder(?![\w-])/, /\.plan-preview-row(?![\w-])/, /\.expand-button(?![\w-])/]) {
      expect(APP_CSS).not.toMatch(gone)
    }
  })

  it('frames a panel\'s preview on a card that draws the border the plan drew', () => {
    expect(prop('.plan-card', 'border')).toBe('1px solid var(--border)')
    expect(prop('.plan-card .area-plan', 'border')).toBe('0')
  })
})

describe('the file row', () => {
  it('puts the name and size on the left and the buttons on the right, and wraps in a narrow window', () => {
    expect(prop('.model-file', 'display')).toBe('flex')
    expect(prop('.model-file', 'justify-content')).toBe('space-between')
    expect(prop('.model-file', 'flex-wrap')).toBe('wrap')
    expect(prop('.model-file-actions', 'display')).toBe('flex')
    expect(prop('.model-file-actions', 'flex-wrap')).toBe('wrap')
  })

  it('wraps a long name rather than cutting it, so no tooltip or slide is needed to read it', () => {
    expect(prop('.model-file-name-text', 'overflow-wrap')).toBe('anywhere')
    expect(declaration(APP_CSS, '.model-file-name-text', 'text-overflow')).toBeNull()
  })

  it('shows every button\'s word: the dialog has the width, so no container query hides them', () => {
    expect(APP_CSS).not.toMatch(/@container model-section/)
    expect(APP_CSS).not.toMatch(/model-file-action-word/)
  })

  it('is Download, Replace and Remove, in that row, for a role that may change the model', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
    render(<Model3DUploader device={DEVICE} canManage showToast={vi.fn()} />)
    const row = (await screen.findByRole('link', { name: /Download/ })).parentElement
    expect(row).toHaveClass('model-file-actions')
    expect([...row.children].map(b => b.textContent.trim())).toEqual(['Download', 'Replace', 'Remove'])
  })
})

describe('the word-trigger tip', () => {
  it('is small, and not in capitals, wherever it sits', () => {
    expect(prop('.help-tip.help-tip-text', 'text-transform')).toBe('none')
    expect(prop('.help-tip.help-tip-text', 'width')).toBe('auto')
    expect(declaration(APP_CSS, '.help-tip.help-tip-text', 'margin-left')).toBeNull()
  })
})

describe('the empty drop zone', () => {
  const EMPTY = { asset_id: 'dev-1', asset_name: 'CNC_01', model_3d_path: null }

  it('says where models are kept, in full, to someone who may upload one', async () => {
    const { MODEL_STORAGE_NOTE } = await import('../components/common/Model3DUploader')
    render(<Model3DUploader device={EMPTY} canManage showToast={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /Upload a 3D model/i })
    expect(zone).toHaveTextContent(MODEL_STORAGE_NOTE)
  })

  it('takes the dialog\'s body, as the viewer does, rather than keeping a preview\'s shape', () => {
    expect(screen.queryByRole('button', { name: /Upload a 3D model/i })).toBeNull()
    render(<Model3DUploader device={EMPTY} canManage showToast={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Upload a 3D model/i })).toHaveClass('modal-fill')
    expect(declaration(APP_CSS, '.model-drop', 'aspect-ratio')).toBeNull()
  })
})

/* The viewer was a 16:9 preview as wide as the drawer, always drawn (#1070, #1380). It is the
   dialog's view only, and takes the height the dialog leaves. */
describe('the viewer', () => {
  it('takes the dialog\'s width and the height the file row and the hint leave', () => {
    expect(prop('.model-viewer-frame', 'width')).toBe('100%')
    expect(declaration(APP_CSS, '.model-viewer-frame', 'aspect-ratio')).toBeNull()
    expect(prop('.model-viewer-expanded > .model-viewer-frame', 'flex')).toBe('1 1 auto')
    expect(prop('.model-viewer-expanded > .model-viewer-frame', 'min-height')).toBe('0')
  })

  it('has one box for the viewer, its loading line and its failure line', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
    render(<Model3DUploader device={DEVICE} canManage showToast={vi.fn()} />)
    expect(screen.getByTestId('model-3d-viewer-loading')).toHaveClass('model-viewer-frame')
    expect((await screen.findByTestId('model-3d-viewer')).parentElement).toHaveClass('model-viewer-frame')
  })
})

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { declaration } from '../test/themeColours'
import { Model3DUploader, Model3DLabel, MODEL_STORAGE_NOTE } from '../components/common/Model3DUploader'

/**
 * Where the Expand button and the model's buttons sit. Expand is in the top-right corner of what
 * it enlarges, wherever that is (one rule, `.expand-corner`); Download, Replace and Remove share
 * the tile's width in equal columns; the public-bucket note is the "Public" marker's tip on the
 * section label once a model is attached, and is said in full on the empty drop zone. jsdom lays
 * nothing out, so the geometry is read from App.css.
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

describe('the attached model\'s buttons', () => {
  it('share the tile\'s width in equal columns, one per button', () => {
    expect(prop('.model-file-actions', 'display')).toBe('grid')
    expect(prop('.model-file-actions', 'grid-auto-flow')).toBe('column')
    expect(prop('.model-file-actions', 'grid-auto-columns')).toBe('minmax(0, 1fr)')
    expect(prop('.model-file-actions > .btn', 'justify-content')).toBe('center')
  })

  it('keep their icons and drop their words in a tile too narrow for three, the word kept as the name', () => {
    expect(prop('.model-tile', 'container')).toBe('model-tile / inline-size')
    const narrow = APP_CSS.match(/@container model-tile \(max-width: (\d+)px\) \{\s*([^{]+)\{([^}]*)\}/)
    expect(narrow).not.toBeNull()
    expect(narrow[2].trim()).toBe('.model-file-actions:has(> :nth-child(3)) .model-file-action-word')
    // Visually hidden, not display:none, so the word is still each button's accessible name.
    expect(narrow[3]).toMatch(/clip-path:\s*inset\(50%\)/)
    expect(narrow[3]).not.toMatch(/display:\s*none/)
  })

  it('are Download, Replace and Remove, in that row', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
    render(<Model3DUploader device={DEVICE} canManage showToast={vi.fn()} />)
    const row = (await screen.findByRole('link', { name: /Download/ })).parentElement
    expect(row).toHaveClass('model-file-actions')
    expect([...row.children].map(b => b.textContent.trim())).toEqual(['Download', 'Replace', 'Remove'])
  })
})

describe('the 3D Model label', () => {
  it('carries the public-bucket note on a "Public" marker once a model is attached, which the keyboard reaches', () => {
    render(<Model3DLabel attached />)
    expect(screen.getByText('3D Model')).toBeInTheDocument()
    // Its visible word is its name.
    const marker = screen.getByRole('button', { name: 'Public' })
    expect(marker).toHaveClass('help-tip-text')
    expect(marker).not.toHaveAttribute('title')
    fireEvent.focus(marker)
    expect(screen.getByRole('tooltip')).toHaveTextContent(MODEL_STORAGE_NOTE)
    expect(MODEL_STORAGE_NOTE).toBe('Stored in the public asset-3d-models bucket so exported shells can be opened by any AAS viewer — anyone with the link can read it.')
  })

  it('has no marker while nothing is attached: the drop zone says it', () => {
    render(<Model3DLabel />)
    expect(screen.getByText('3D Model')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('sits the marker at the label\'s right, in the label\'s size but not its capitals', () => {
    expect(prop('.help-tip.help-tip-text', 'margin-left')).toBe('auto')
    expect(prop('.help-tip.help-tip-text', 'text-transform')).toBe('none')
    expect(prop('.help-tip.help-tip-text', 'width')).toBe('auto')
  })

  it('leaves the note off the attached model\'s tile: the marker carries it', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
    render(<Model3DUploader device={DEVICE} canManage showToast={vi.fn()} />)
    await screen.findByRole('link', { name: /Download/ })
    expect(screen.queryByText(/asset-3d-models/)).toBeNull()
    expect(screen.queryByText(/anyone with the link/)).toBeNull()
  })
})

describe('the empty drop zone', () => {
  const EMPTY = { asset_id: 'dev-1', asset_name: 'CNC_01', model_3d_path: null }

  it('says where models are kept, in full, to someone who may upload one', () => {
    render(<Model3DUploader device={EMPTY} canManage showToast={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /Upload a 3D model/i })
    expect(zone).toHaveTextContent(MODEL_STORAGE_NOTE)
  })

  it('says nothing about storage to someone who may not upload', () => {
    render(<Model3DUploader device={EMPTY} canManage={false} showToast={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Upload a 3D model/i })).not.toHaveTextContent(/anyone with the link/)
  })

  it('is as tall as the viewer, so the tile keeps its height with and without a model', () => {
    expect(prop('.model-drop', 'min-height')).toBe(prop('.model-viewer-frame', 'height'))
  })
})

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
 * the card's width in equal columns; the public-bucket note is the "?" tip on the section label.
 * jsdom lays nothing out, so the geometry is read from App.css.
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
  it('share the card\'s width in equal columns, wrapping only when too narrow for three', () => {
    expect(prop('.model-file-actions', 'display')).toBe('grid')
    expect(prop('.model-file-actions', 'grid-template-columns')).toMatch(/^repeat\(auto-fit, minmax\(\d+px, 1fr\)\)$/)
    // A row of their own under the file's name, whatever fits beside it.
    expect(prop('.model-file-actions', 'flex')).toBe('1 1 100%')
    expect(prop('.model-file-actions > .btn', 'justify-content')).toBe('center')
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
  it('carries the public-bucket note in its "?" tip, which the keyboard reaches', () => {
    render(<Model3DLabel />)
    expect(screen.getByText('3D Model')).toBeInTheDocument()
    const tip = screen.getByRole('button', { name: 'Where 3D models are kept' })
    expect(tip).not.toHaveAttribute('title')
    fireEvent.focus(tip)
    expect(screen.getByRole('tooltip')).toHaveTextContent(MODEL_STORAGE_NOTE)
    expect(MODEL_STORAGE_NOTE).toBe('Stored in the public asset-3d-models bucket so exported shells can be opened by any AAS viewer — anyone with the link can read it.')
  })

  it('is the only place the note is shown: not under the card', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
    render(<Model3DUploader device={DEVICE} canManage showToast={vi.fn()} />)
    await screen.findByRole('link', { name: /Download/ })
    expect(screen.queryByText(/asset-3d-models/)).toBeNull()
    expect(screen.queryByText(/anyone with the link/)).toBeNull()
  })
})

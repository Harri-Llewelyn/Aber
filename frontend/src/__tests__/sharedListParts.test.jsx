import React, { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SearchInput } from '../components/common/SearchInput'
import { ClearFilters } from '../components/common/ClearFilters'
import { ListFoot } from '../components/common/ListFoot'
import { LoadingState } from '../components/common/LoadingState'
import { EmptyState } from '../components/common/EmptyState'
import { ActionButton } from '../components/common/ActionButton'

function Harness({ initial = '', onChange }) {
  const [value, setValue] = useState(initial)
  return (
    <SearchInput value={value} placeholder="Search cells…" ariaLabel="Search cells"
      onChange={v => { setValue(v); onChange?.(v) }} />
  )
}

describe('SearchInput', () => {
  it('is a search field with an accessible name and the page placeholder', () => {
    render(<Harness />)
    const input = screen.getByPlaceholderText('Search cells…')
    expect(input).toHaveAttribute('type', 'search')
    expect(screen.getByLabelText('Search cells')).toBe(input)
  })

  it('passes the string, not the event, to onChange', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Search cells'), { target: { value: 'pump' } })
    expect(onChange).toHaveBeenCalledWith('pump')
  })

  it('shows the clear button only while there is a value, and clears with it', () => {
    render(<Harness initial="pump" />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByLabelText('Search cells')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('clears on Escape', () => {
    render(<Harness initial="pump" />)
    fireEvent.keyDown(screen.getByLabelText('Search cells'), { key: 'Escape' })
    expect(screen.getByLabelText('Search cells')).toHaveValue('')
  })

  it('takes its width class from the width prop, lg by default', () => {
    const { container, rerender } = render(<SearchInput value="" onChange={() => {}} ariaLabel="x" />)
    expect(container.firstChild).toHaveClass('control-lg')
    rerender(<SearchInput value="" onChange={() => {}} ariaLabel="x" width="sm" />)
    expect(container.firstChild).toHaveClass('control-sm')
  })
})

describe('ClearFilters', () => {
  it('renders nothing at zero', () => {
    const { container } = render(<ClearFilters count={0} onClear={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reads "Clear filters (N)" and calls onClear', () => {
    const onClear = vi.fn()
    render(<ClearFilters count={2} onClear={onClear} />)
    const btn = screen.getByRole('button', { name: /Clear filters \(2\)/ })
    expect(btn).toHaveClass('filter-bar-clear')
    fireEvent.click(btn)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('ListFoot', () => {
  it('offers the rows left when fewer than a step remain', () => {
    const onMore = vi.fn()
    render(<ListFoot shown={30} total={57} step={30} onMore={onMore} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show 27 more' }))
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('names the full step when more than a step remains', () => {
    render(<ListFoot shown={30} total={100} step={30} onMore={() => {}} />)
    expect(screen.getByRole('button', { name: 'Show 30 more' })).toBeInTheDocument()
  })

  it('says everything is shown at the end', () => {
    render(<ListFoot shown={57} total={57} onMore={() => {}} />)
    expect(screen.getByText('All 57 shown.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(<ListFoot shown={0} total={0} onMore={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the pending state on the button', () => {
    render(<ListFoot shown={30} total={57} pending onMore={() => {}} />)
    const btn = screen.getByRole('button', { name: /Loading…/ })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
  })
})

describe('LoadingState', () => {
  it('says what is loading, with a spinner', () => {
    const { container } = render(<LoadingState label="cells" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading cells…')
    expect(container.querySelector('.loading-wrap .spinner')).not.toBeNull()
  })
})

describe('EmptyState', () => {
  it('shows the message, and the filtered message only when filtered', () => {
    const props = { message: 'No cells yet.', filteredMessage: 'No cells match these filters.' }
    const { rerender } = render(<EmptyState {...props} />)
    expect(screen.getByText('No cells yet.')).toHaveClass('empty-text')
    rerender(<EmptyState {...props} filtered />)
    expect(screen.getByText('No cells match these filters.')).toBeInTheDocument()
    expect(screen.queryByText('No cells yet.')).toBeNull()
  })

  it('falls back to the message when filtered has no message of its own', () => {
    render(<EmptyState message="No cells yet." filtered />)
    expect(screen.getByText('No cells yet.')).toBeInTheDocument()
  })

  it('renders the icon and any child under the sentence', () => {
    const { container } = render(
      <EmptyState icon={<svg data-testid="i" />} message="No cells yet."><button>Add</button></EmptyState>
    )
    expect(container.querySelector('.empty-icon [data-testid="i"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})

describe('ActionButton permitted', () => {
  it('is disabled, marked and titled when not permitted, and never calls onClick', () => {
    const onClick = vi.fn()
    render(<ActionButton permitted={false} deniedTitle="Admins only." onClick={onClick}>Archive</ActionButton>)
    const btn = screen.getByRole('button', { name: 'Archive' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveClass('btn-disabled')
    expect(btn).toHaveAttribute('title', 'Admins only.')
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is unchanged when permitted, and keeps its own title', () => {
    const onClick = vi.fn()
    render(<ActionButton title="Archive it" deniedTitle="Admins only." onClick={onClick}>Archive</ActionButton>)
    const btn = screen.getByRole('button', { name: 'Archive' })
    expect(btn).not.toBeDisabled()
    expect(btn).not.toHaveClass('btn-disabled')
    expect(btn).toHaveAttribute('title', 'Archive it')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

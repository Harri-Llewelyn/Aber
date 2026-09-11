import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import CopyableId from '../components/common/CopyableId';

const VALUE = 'devccd1994488054c11ae66e';

describe('CopyableId', () => {
  let originalClipboard;
  let originalExecCommand;

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    originalExecCommand = document.execCommand;
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete navigator.clipboard;
    }
    document.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  const setClipboard = (value) =>
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });

  it('renders the identifier as a button so it is keyboard reachable', () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue() });
    render(<CopyableId value={VALUE} label="Sparkplug device id" />);

    const button = screen.getByRole('button', { name: /copy sparkplug device id/i });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain(VALUE);
  });

  it('copies via the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard({ writeText });
    const onNotify = vi.fn();

    render(<CopyableId value={VALUE} label="Sparkplug device id" onNotify={onNotify} />);
    fireEvent.click(screen.getByRole('button'));

    expect(writeText).toHaveBeenCalledWith(VALUE);
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Copied'), 'success'));
  });

  // The dashboard is served over plain HTTP, so navigator.clipboard is undefined for anyone opening
  // it by IP across the plant network.
  it('falls back to execCommand when the clipboard API is unavailable (non-secure context)', async () => {
    delete navigator.clipboard;
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    const onNotify = vi.fn();

    render(<CopyableId value={VALUE} label="Sparkplug device id" onNotify={onNotify} />);
    fireEvent.click(screen.getByRole('button'));

    expect(execCommand).toHaveBeenCalledWith('copy');
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Copied'), 'success'));
  });

  it('falls back when the clipboard API is present but rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    render(<CopyableId value={VALUE} label="Sparkplug device id" />);
    fireEvent.click(screen.getByRole('button'));

    // The rejection is awaited, so the fallback runs on a later microtask.
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
  });

  it('reports failure rather than silently doing nothing when both paths fail', async () => {
    delete navigator.clipboard;
    document.execCommand = vi.fn().mockReturnValue(false);
    const onNotify = vi.fn();

    render(<CopyableId value={VALUE} label="Sparkplug device id" onNotify={onNotify} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Could not copy'), 'error'));
    expect(screen.getByText(/copy blocked/i)).toBeTruthy();
  });

  it('renders a placeholder instead of an empty control when there is no value', () => {
    render(<CopyableId value={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

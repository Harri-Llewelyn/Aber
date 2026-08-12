import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DigitalThreadTab } from '../components/tabs/DigitalThreadTab';
import { api } from '../api';

/**
 * The Devices page no longer opens a Digital Thread dialog; it navigates here with the device it
 * was on. These tests cover the handover itself -- that the filters actually narrow to that
 * device, and that the page stays a normal page afterwards, which was the whole reason for
 * replacing the modal.
 */
vi.mock('../api', () => ({ api: { get: vi.fn() } }));

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';

const events = [
  {
    id: 'dt-1', entity_type: 'DEVICE', entity_id: DEVICE_ID, action: 'UPDATE',
    description: 'Device renamed', recorded_at: '2026-08-10T10:00:00Z',
    changed_by: 'admin@factoryplus.local', actor_source: 'user'
  }
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/v1/digital-thread')) return Promise.resolve(events);
    if (url === '/api/v1/devices') {
      return Promise.resolve([{ asset_id: DEVICE_ID, asset_name: 'Simulated_CNC_01' }]);
    }
    return Promise.resolve([]);
  });
});

const threadCalls = () =>
  api.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/v1/digital-thread'));

describe('DigitalThreadTab handover', () => {
  it('narrows to the handed-over device', async () => {
    render(<DigitalThreadTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await waitFor(() => expect(threadCalls().length).toBeGreaterThan(0));
    // The id lands in the name filter because that filter matches on id as well as name, which is
    // what makes the handover exact rather than a name search that could match two devices.
    expect(screen.getByPlaceholderText(/Search by entity name or ID/).value).toBe(DEVICE_ID);
    await waitFor(() =>
      expect(threadCalls().some((url) => url.includes(`entity_ids=${DEVICE_ID}`))).toBe(true));
    expect(threadCalls().some((url) => url.includes('entity_type=DEVICE'))).toBe(true);
  });

  it('shows everything when opened without a handover', async () => {
    render(<DigitalThreadTab />);
    await waitFor(() => expect(threadCalls().length).toBeGreaterThan(0));
    expect(threadCalls().every((url) => !url.includes('entity_ids='))).toBe(true);
  });

  it('lets Clear Filters actually clear the handover', async () => {
    const onClearEntity = vi.fn();
    render(<DigitalThreadTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={onClearEntity} />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search by entity name or ID/).value).toBe(DEVICE_ID));

    fireEvent.click(screen.getByRole('button', { name: /clear/i }));

    // Without the callback the parent would still hold the entity and the effect would put the
    // filter straight back, so the button would look broken.
    expect(onClearEntity).toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Search by entity name or ID/).value).toBe('');
  });

  it('re-narrows when a second device is handed over', async () => {
    const other = '99999999-8888-7777-6666-555555555555';
    const { rerender } = render(
      <DigitalThreadTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search by entity name or ID/).value).toBe(DEVICE_ID));

    rerender(<DigitalThreadTab initialEntity={{ id: other, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search by entity name or ID/).value).toBe(other));
  });
});

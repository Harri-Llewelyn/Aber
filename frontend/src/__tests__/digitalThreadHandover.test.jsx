import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DigitalThreadTab } from '../components/tabs/DigitalThreadTab';
import { api } from '../api';

/**
 * The Devices page navigates here with the device it was on. These cover the handover itself: the
 * filters narrow to that device, and the page stays a normal page afterwards.
 */
vi.mock('../api', () => ({ api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn() } }));

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Post-mapping shape, which is what the component receives. api.get is mocked here, so
 * `mapDigitalThreadRow` never runs and the fixture must carry `event_id`, `event_type` and
 * `timestamp` rather than the raw column names.
 */
const events = [
  {
    event_id: 'dt-1', entity_type: 'DEVICE', entity_id: DEVICE_ID, event_type: 'UPDATE',
    description: 'Device renamed', timestamp: '2026-08-10T10:00:00Z',
    changed_by: 'admin@acs-cymru.local', actor_source: 'user',
    old_data: { id: DEVICE_ID, name: 'CNC_01' },
    new_data: { id: DEVICE_ID, name: 'Simulated_CNC_01' }
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

  // The fixture is the shape api.js emits, so the row it produces has to render completely.
  // Asserted so the fixture cannot drift back to raw column names.
  it('renders the handed-over event in full', async () => {
    render(<DigitalThreadTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    // One lane, one marker. The description and the mutation id moved into the drawer -- they
    // describe one EVENT, and a lane is one ASSET.
    const marker = await screen.findByRole('button', { name: /UPDATE on Simulated_CNC_01/ });
    expect(document.querySelectorAll('.dt-lane:not(.dt-axis)').length).toBe(1);
    expect(marker.getAttribute('title')).not.toMatch(/Invalid Date/);

    fireEvent.click(marker);

    expect(await screen.findByText('Device renamed')).toBeInTheDocument();
    expect(screen.getByText('UPDATE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy mutation id dt-1/ })).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  /* The reason the default range is All time: this fixture is dated 2026-08-10 and never refreshed,
     and an operator asking for one asset's history means all of it. */
  it('requests an unbounded window, so an old asset history is not silently empty', async () => {
    render(<DigitalThreadTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await waitFor(() => expect(threadCalls().length).toBeGreaterThan(0));
    expect(threadCalls().every((url) => !url.includes('since='))).toBe(true);
    expect(await screen.findByRole('button', { name: /UPDATE on Simulated_CNC_01/ })).toBeInTheDocument();
  });
});

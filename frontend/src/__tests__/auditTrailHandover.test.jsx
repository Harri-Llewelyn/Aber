import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditTrailTab } from '../components/tabs/AuditTrailTab';
import { api } from '../api';
import { ENTITY_KIND_BY_TABLE } from '../constants';

/**
 * The Devices page navigates here with the device it was on. These cover the handover itself: the
 * filters narrow to that device, and the page stays a normal page afterwards.
 */
vi.mock('../api', () => ({ api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn() } }));

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Post-mapping shape, which is what the component receives. api.get is mocked here, so
 * `mapAuditTrailRow` never runs and the fixture must carry `event_id`, `event_type` and
 * `timestamp` rather than the raw column names.
 */
const events = [
  {
    event_id: 'trail-1', entity_type: 'DEVICE', entity_id: DEVICE_ID, event_type: 'UPDATE',
    description: 'Device renamed', timestamp: '2026-08-10T10:00:00Z',
    changed_by: 'admin@aber.local', actor_source: 'user',
    old_data: { id: DEVICE_ID, name: 'CNC_01' },
    new_data: { id: DEVICE_ID, name: 'Simulated_CNC_01' }
  }
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/v1/audit-trail')) return Promise.resolve(events);
    if (url === '/api/v1/devices') {
      return Promise.resolve([{ asset_id: DEVICE_ID, asset_name: 'Simulated_CNC_01' }]);
    }
    return Promise.resolve([]);
  });
});

const trailCalls = () =>
  api.get.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/v1/audit-trail'));

describe('AuditTrailTab handover', () => {
  it('narrows to the handed-over device', async () => {
    render(<AuditTrailTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await waitFor(() => expect(trailCalls().length).toBeGreaterThan(0));
    // The id lands in the name filter because that filter matches on id as well as name, which is
    // what makes the handover exact rather than a name search that could match two devices. The
    // database matches it now, so a handover from a DELETED asset's page works too.
    expect(screen.getByPlaceholderText('Search a name or any ID…').value).toBe(DEVICE_ID);
    await waitFor(() =>
      expect(trailCalls().some((url) => url.includes(`search=${DEVICE_ID}`))).toBe(true));
    // No kind filter: the device's nameplate and schema rows carry its id too, and filtering to
    // DEVICE would drop them (see below).
    expect(trailCalls().every((url) => !url.includes('entity_type='))).toBe(true);
  });

  it('keeps the kind filter for a hand-over that nothing else is keyed by', async () => {
    const GATEWAY_ID = '22222222-3333-4444-5555-666666666666';
    render(<AuditTrailTab initialEntity={{ id: GATEWAY_ID, type: 'GATEWAY' }} onClearEntity={vi.fn()} />);
    await waitFor(() =>
      expect(trailCalls().some((url) => url.includes(`search=${GATEWAY_ID}`))).toBe(true));
    expect(trailCalls().every((url) => url.includes('entity_type=GATEWAY'))).toBe(true);
  });

  it('draws the device, its nameplate and its schema attachments from one hand-over', async () => {
    // A schema change from the Devices page is a device_submodels row keyed by the device's id; in
    // 1.0 it was a devices UPDATE, which this view showed, so dropping the kind is what keeps it.
    const keyedRows = [
      events[0],
      {
        event_id: 'trail-2', entity_type: 'device_nameplate', entity_id: DEVICE_ID, event_type: 'INSERT',
        timestamp: '2026-08-11T10:00:00Z', actor_source: 'user',
        old_data: null, new_data: { device_id: DEVICE_ID, serial_number: 'SN-1' }
      },
      {
        event_id: 'trail-3', entity_type: 'device_submodels', entity_id: DEVICE_ID, event_type: 'INSERT',
        timestamp: '2026-08-12T10:00:00Z', actor_source: 'user',
        old_data: null, new_data: { device_id: DEVICE_ID, schema_id: 'sch-1', submodel_key: null }
      }
    ];
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/v1/audit-trail')) {
        // Honours the kind filter as audit_trail_page() does, so a DEVICE filter would drop rows.
        const kind = new URL(url, 'http://trail.test').searchParams.get('entity_type');
        return Promise.resolve(keyedRows.filter((r) =>
          !kind || r.entity_type === kind || ENTITY_KIND_BY_TABLE[r.entity_type] === kind));
      }
      if (url === '/api/v1/devices') {
        return Promise.resolve([{ asset_id: DEVICE_ID, asset_name: 'Simulated_CNC_01' }]);
      }
      return Promise.resolve([]);
    });

    render(<AuditTrailTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await screen.findByRole('button', { name: /UPDATE on Simulated_CNC_01/ });
    expect(document.querySelectorAll('.trail-lane:not(.trail-axis)').length).toBe(3);
    expect(screen.getAllByRole('button', { name: /INSERT on Simulated_CNC_01/ })).toHaveLength(2);
  });

  it('shows everything when opened without a handover', async () => {
    render(<AuditTrailTab />);
    await waitFor(() => expect(trailCalls().length).toBeGreaterThan(0));
    expect(trailCalls().every((url) => !url.includes('search='))).toBe(true);
  });

  it('lets Clear Filters actually clear the handover', async () => {
    const onClearEntity = vi.fn();
    render(<AuditTrailTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={onClearEntity} />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Search a name or any ID…').value).toBe(DEVICE_ID));

    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));

    // Without the callback the parent would still hold the entity and the effect would put the
    // filter straight back, so the button would look broken.
    expect(onClearEntity).toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Search a name or any ID…').value).toBe('');
  });

  it('re-narrows when a second device is handed over', async () => {
    const other = '99999999-8888-7777-6666-555555555555';
    const { rerender } = render(
      <AuditTrailTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Search a name or any ID…').value).toBe(DEVICE_ID));

    rerender(<AuditTrailTab initialEntity={{ id: other, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Search a name or any ID…').value).toBe(other));
  });

  // The fixture is the shape api.js emits, so the row it produces has to render completely.
  // Asserted so the fixture cannot drift back to raw column names.
  it('renders the handed-over event in full', async () => {
    render(<AuditTrailTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    // One lane, one marker. The description and the mutation id moved into the drawer -- they
    // describe one EVENT, and a lane is one ASSET.
    const marker = await screen.findByRole('button', { name: /UPDATE on Simulated_CNC_01/ });
    expect(document.querySelectorAll('.trail-lane:not(.trail-axis)').length).toBe(1);
    expect(marker.getAttribute('title')).not.toMatch(/Invalid Date/);

    fireEvent.click(marker);

    expect(await screen.findByText('Device renamed')).toBeInTheDocument();
    expect(screen.getByText('UPDATE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy mutation id trail-1/ })).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  /* The reason the default range is All time: this fixture is dated 2026-08-10 and never refreshed,
     and an operator asking for one asset's history means all of it. */
  it('requests an unbounded window, so an old asset history is not silently empty', async () => {
    render(<AuditTrailTab initialEntity={{ id: DEVICE_ID, type: 'DEVICE' }} onClearEntity={vi.fn()} />);

    await waitFor(() => expect(trailCalls().length).toBeGreaterThan(0));
    expect(trailCalls().every((url) => !url.includes('since='))).toBe(true);
    expect(await screen.findByRole('button', { name: /UPDATE on Simulated_CNC_01/ })).toBeInTheDocument();
  });
});

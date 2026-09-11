import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceNameplateModal } from '../components/modals/DeviceNameplateModal';
import { api } from '../api';

// The modal talks only to `api`, so that is what is mocked. The resolution rule (device-published
// beats stored) lives in api.js and the exporter; here the question is whether the form honours it.
vi.mock('../api', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() }
}));

const asset = { asset_id: 'dev-123', asset_name: 'Simulated_CNC_01' };

const template = [
  { id_short: 'URIOfTheProduct', semantic_id: '0112/2///61987#ABN590#002', semantic_id_type: 'IRDI', is_mandatory: true, ordinal: 1, description: 'Product URI' },
  { id_short: 'ManufacturerName', semantic_id: '0112/2///61987#ABA565#009', semantic_id_type: 'IRDI', is_mandatory: true, ordinal: 2, description: 'Manufacturer' },
  { id_short: 'SerialNumber', semantic_id: '0112/2///61987#ABA951#009', semantic_id_type: 'IRDI', is_mandatory: false, ordinal: 10, description: 'Serial number' },
  { id_short: 'YearOfConstruction', semantic_id: '0112/2///61987#ABP000#002', semantic_id_type: 'IRDI', is_mandatory: true, ordinal: 11, description: 'Year' }
];

const respond = ({ stored = null, published = {} } = {}) => {
  api.get.mockResolvedValue({ stored, template, published });
};

const fieldFor = (label) => screen.getByLabelText(new RegExp(`^${label}`));

describe('DeviceNameplateModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.put.mockResolvedValue({});
    api.post.mockResolvedValue({});
  });

  it('renders an empty form for a device with no nameplate row', async () => {
    respond();
    render(<DeviceNameplateModal asset={asset} canManage onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/IDTA 02006/)).toBeInTheDocument());
    // No row is the normal state for a device nobody has filled in, not an error.
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(fieldFor('Serial number').value).toBe('');
  });

  it('locks a field the device publishes and shows the device value', async () => {
    respond({ published: { serial_number: 'SN-FROM-DBIRTH' } });
    render(<DeviceNameplateModal asset={asset} canManage onClose={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Serial number')).toBeDisabled());

    // The exporter prefers the published value, so an editable field here would accept a change
    // that never reached the shell -- the failure this locking exists to prevent.
    expect(fieldFor('Serial number').value).toBe('SN-FROM-DBIRTH');
    expect(fieldFor('Manufacturer')).not.toBeDisabled();
    expect(screen.getByText(/publishes 1 of these itself/)).toBeInTheDocument();
  });

  it('saves the edited fields', async () => {
    respond({ stored: { device_id: 'dev-123', manufacturer_name: 'DMG Mori' } });
    const onClose = vi.fn();
    render(<DeviceNameplateModal asset={asset} canManage onClose={onClose} showToast={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Manufacturer').value).toBe('DMG Mori'));

    fireEvent.change(fieldFor('Serial number'), { target: { value: 'SN-42' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = api.put.mock.calls[0];
    expect(path).toBe('/api/v1/devices/dev-123/nameplate');
    expect(body.serial_number).toBe('SN-42');
    expect(body.manufacturer_name).toBe('DMG Mori');
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses a year that is not four digits', async () => {
    respond();
    render(<DeviceNameplateModal asset={asset} canManage onClose={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Year of construction')).toBeInTheDocument());

    fireEvent.change(fieldFor('Year of construction'), { target: { value: '24' } });
    // Mirrors device_nameplate_year_shape: the guard is in the database, and a form that let this
    // through would surface as an opaque constraint violation on save.
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByText(/must be four digits/)).toBeInTheDocument();
  });

  it('refuses a product URI with no scheme', async () => {
    respond();
    render(<DeviceNameplateModal asset={asset} canManage onClose={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Product URI')).toBeInTheDocument());

    fireEvent.change(fieldFor('Product URI'), { target: { value: 'manufacturer.example/p/1' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByText(/must be an absolute IRI/)).toBeInTheDocument();
  });

  it('reports clearing every field as a deletion rather than a save', async () => {
    respond({ stored: { device_id: 'dev-123', serial_number: 'SN-42' } });
    const showToast = vi.fn();
    render(<DeviceNameplateModal asset={asset} canManage onClose={vi.fn()} showToast={showToast} />);
    await waitFor(() => expect(fieldFor('Serial number').value).toBe('SN-42'));

    fireEvent.change(fieldFor('Serial number'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    // api.js deletes the row when every field is empty, because "no nameplate" is modelled as no
    // row. Saying "saved" would misdescribe what happened to the device's shell.
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Nameplate cleared', 'success'));
  });

  it('is read-only without the manage permission', async () => {
    respond({ stored: { device_id: 'dev-123', manufacturer_name: 'DMG Mori' } });
    render(<DeviceNameplateModal asset={asset} canManage={false} onClose={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Manufacturer').value).toBe('DMG Mori'));

    expect(fieldFor('Manufacturer')).toBeDisabled();
  });

  it('offers one primary control, and it says what it will actually do', async () => {
    // The footer never lies and is never dead: a disabled Save is right for a temporary refusal,
    // but for a permanent one the label is swapped, since nothing styles `.btn:disabled`.
    respond({ stored: { device_id: 'dev-123' } });
    render(<DeviceNameplateModal asset={asset} canManage={false} canPropose onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  it('gives somebody who may save the Save button and nothing else', async () => {
    respond({ stored: { device_id: 'dev-123', manufacturer_name: 'DMG Mori' } });
    render(<DeviceNameplateModal asset={asset} canManage canPropose onClose={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Manufacturer').value).toBe('DMG Mori'));

    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    // Somebody who can simply make the change has no reason to ask permission for it, and
    // offering both would spend an approver's attention for nothing.
    expect(screen.queryByRole('button', { name: /propose a change/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/you are reading this nameplate/i)).not.toBeInTheDocument();
  });

  it('says nothing extra above the form when the footer already carries it', async () => {
    // The first cut explained the read-only state in a strip above the form AND offered the route
    // there, while a dead Save sat below -- three pieces of furniture for one fact.
    respond({ stored: { device_id: 'dev-123' } });
    render(<DeviceNameplateModal asset={asset} canManage={false} canPropose onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument());

    expect(screen.queryByText(/you are reading this nameplate/i)).not.toBeInTheDocument();
  });

  it('files the proposal itself, as a patch of what moved', async () => {
    // THIS DIALOG IS THE FORM NOW. It used to hand over to a composer on the Approvals page that
    // listed these same eleven columns as bare text inputs -- a second form for one nameplate.
    respond({ stored: { device_id: 'dev-123', manufacturer_name: 'DMG Mori' } });
    const onClose = vi.fn();
    render(<DeviceNameplateModal asset={asset} canManage={false} canPropose onClose={onClose} showToast={vi.fn()} />);
    await waitFor(() => expect(fieldFor('Manufacturer').value).toBe('DMG Mori'));

    fireEvent.change(fieldFor('Serial number'), { target: { value: 'SN-4471' } });
    fireEvent.click(screen.getByRole('button', { name: /propose a change/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/proposals', expect.objectContaining({
      entity_type: 'device_nameplate',
      entity_id: 'dev-123',
      // ONE KEY. The manufacturer was seeded from the row and never touched, so it is not part of
      // what is being asked for -- an approver reading the diff sees the one field that moved.
      patch: { serial_number: 'SN-4471' }
    })));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('lets a proposer type into the fields, which a pure reader cannot', async () => {
    // The whole point: they are filling in a request, not browsing. Without this the form would
    // be disabled and its own Propose button would have nothing to send.
    respond({ stored: { device_id: 'dev-123' } });
    render(<DeviceNameplateModal asset={asset} canManage={false} canPropose onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /propose a change/i })).toBeInTheDocument());
    expect(fieldFor('Serial number')).not.toBeDisabled();
  });

  it('explains itself when there is no route to offer at all', async () => {
    // A role holding neither `device:manage` nor `proposal:create`, an Auditor. A form whose only
    // control is Cancel has to explain itself.
    respond({ stored: { device_id: 'dev-123' } });
    render(<DeviceNameplateModal asset={asset} canManage={false} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/you are reading this nameplate/i)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /propose a change/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/ask one of them to make the change/i)).toBeInTheDocument();
  });
});

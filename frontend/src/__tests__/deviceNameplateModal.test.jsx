import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceNameplateModal } from '../components/modals/DeviceNameplateModal';
import { api } from '../api';

// The modal talks only to `api`, so that is what is mocked -- not supabase underneath it. The
// resolution rule this file is really about (device-published beats stored) lives in api.js and in
// the exporter; here the question is whether the FORM honours it, which is a rendering question.
vi.mock('../api', () => ({
  api: { get: vi.fn(), put: vi.fn() }
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
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });
});

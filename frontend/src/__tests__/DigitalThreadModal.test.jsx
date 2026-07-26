import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DigitalThreadModal } from '../components/modals/DigitalThreadModal';
import { api } from '../api';

vi.mock('../lib/supabaseClient', () => {
  const sampleEvents = [
    {
      id: 'dt-001',
      entity_type: 'cell',
      entity_id: 'cell-xyz-123',
      action: 'UPDATE',
      description: 'Cell location updated',
      recorded_at: '2026-07-26T10:00:00Z',
      changed_by: 'admin@factoryplus.local',
      old_data: {},
      new_data: {}
    }
  ];

  const mockQueryBuilder = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: sampleEvents, error: null }),
    then: vi.fn((resolve) => resolve({ data: sampleEvents, error: null }))
  };

  return {
    supabase: {
      from: vi.fn(() => mockQueryBuilder)
    }
  };
});

describe('DigitalThreadModal Regression Test', () => {
  it('renders DigitalThreadModal and fetches per-entity digital thread without throwing Unhandled API path', async () => {
    const apiGetSpy = vi.spyOn(api, 'get');

    render(
      <DigitalThreadModal
        entityType="cells"
        entityId="cell-xyz-123"
        displayName="Cell Alpha"
        onClose={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading digital trace timeline/i)).toBeNull();
    });

    expect(apiGetSpy).toHaveBeenCalledWith('/api/v1/cells/cell-xyz-123/digital-thread');
    expect(screen.getByText(/Digital Thread — Cell Alpha/i)).toBeDefined();
    expect(screen.getByText(/cell-xyz-123/i)).toBeDefined();
  });
});

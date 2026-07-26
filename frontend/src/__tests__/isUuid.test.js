import { describe, it, expect, vi } from 'vitest';
import { isUuid } from '../utils/isUuid';
import { api } from '../api';
import { supabase } from '../lib/supabaseClient';

vi.mock('../lib/supabaseClient', () => {
  const mockQueryBuilder = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    then: vi.fn((resolve) => resolve({ data: [], error: null }))
  };

  return {
    supabase: {
      from: vi.fn(() => mockQueryBuilder)
    }
  };
});

describe('isUuid helper and injection prevention', () => {
  it('correctly identifies valid UUIDs', () => {
    expect(isUuid('cb46a943-42e1-4c1d-8706-933e08544e30')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('E789A012-3456-4C1D-8706-933E08544E35')).toBe(true);
  });

  it('correctly rejects non-UUID strings and injection payloads', () => {
    expect(isUuid('Simulated_CNC_01')).toBe(false);
    expect(isUuid('x,is_archived.eq.false')).toBe(false);
    expect(isUuid('12345')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('safely uses exact equality matching instead of raw template-literal .or() interpolation', async () => {
    const maliciousId = 'x,is_archived.eq.false';
    
    // Call api.post for archiving with a malicious ID string containing commas/injection syntax
    await api.post(`/api/v1/devices/${maliciousId}/archive`, { auto_delete_days: 7 });

    const queryBuilder = supabase.from('devices');
    
    // Assert eq('name', maliciousId) was called safely rather than raw template interpolation
    expect(queryBuilder.eq).toHaveBeenCalledWith('name', maliciousId);
  });
});

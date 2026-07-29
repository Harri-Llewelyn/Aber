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

    // Assert exact equality matching rather than raw template interpolation. The column is
    // always `id` now: devices used to be addressable by Sparkplug B name as well, which is
    // why this call site had to sniff the id's format first.
    expect(queryBuilder.eq).toHaveBeenCalledWith('id', maliciousId);
    expect(queryBuilder.or).not.toHaveBeenCalled();
  });

  it('enforces exact regex match between frontend and Deno edge function isUuid implementations', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const frontendFile = path.resolve(__dirname, '../utils/isUuid.js');
    const edgeFunctionFile = path.resolve(__dirname, '../../../supabase/functions/approve-quarantine/isUuid.ts');

    const frontendCode = fs.readFileSync(frontendFile, 'utf-8');
    const edgeFunctionCode = fs.readFileSync(edgeFunctionFile, 'utf-8');

    const extractRegex = (code) => {
      const match = code.match(/const\s+UUID_REGEX\s*=\s*(.+);/);
      return match ? match[1].trim() : null;
    };

    const frontendRegex = extractRegex(frontendCode);
    const edgeFunctionRegex = extractRegex(edgeFunctionCode);

    expect(frontendRegex).not.toBeNull();
    expect(edgeFunctionRegex).not.toBeNull();
    expect(frontendRegex).toBe(edgeFunctionRegex);
  });
});

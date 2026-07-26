import { describe, it, expect, vi } from 'vitest';
import { api } from '../api';

// Mock Supabase client responses so api methods complete without database errors
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

describe('API Path Coverage Test', () => {
  const getPaths = [
    '/api/v1/archives',
    '/api/v1/cells',
    '/api/v1/gateways',
    '/api/v1/devices',
    '/api/v1/assets',
    '/api/v1/quarantine',
    '/api/v1/digital-thread',
    '/api/v1/cells/some-id/digital-thread',
    '/api/v1/documents?entity_type=cell&entity_id=123',
    '/api/v1/devices/dev-123/config',
    '/api/v1/schemas',
    '/api/v1/directory',
    '/api/v1/gitops/status',
    '/api/v1/stats',
    '/api/v1/telemetry?limit=500'
  ];

  const postPaths = [
    '/api/v1/cells',
    '/api/v1/gateways',
    '/api/v1/devices',
    '/api/v1/cells/cell-123/archive',
    '/api/v1/cells/cell-123/restore',
    '/api/v1/quarantine/dev-123/reject',
    '/api/v1/documents',
    '/api/v1/schemas/validate',
    '/api/v1/schemas',
    '/api/v1/gitops/deploy-flow'
  ];

  const putPaths = [
    '/api/v1/cells/cell-123',
    '/api/v1/gateways/gw-123',
    '/api/v1/devices/dev-123',
    '/api/v1/cells/cell-123/archive',
    '/api/v1/cells/cell-123/restore',
    '/api/v1/documents/doc-123'
  ];

  const deletePaths = [
    '/api/v1/cells/cell-123',
    '/api/v1/gateways/gw-123',
    '/api/v1/devices/dev-123',
    '/api/v1/documents/doc-123'
  ];

  it('should handle all GET path strings used across components without throwing Unhandled API path', async () => {
    for (const path of getPaths) {
      await expect(api.get(path)).resolves.not.toThrow();
    }
  });

  it('should handle all POST path strings used across components without throwing Unhandled API path', async () => {
    for (const path of postPaths) {
      await expect(api.post(path, {})).resolves.not.toThrow();
    }
  });

  it('should handle all PUT path strings used across components without throwing Unhandled API path', async () => {
    for (const path of putPaths) {
      await expect(api.put(path, {})).resolves.not.toThrow();
    }
  });

  it('should handle all DELETE path strings used across components without throwing Unhandled API path', async () => {
    for (const path of deletePaths) {
      await expect(api.delete(path)).resolves.not.toThrow();
    }
  });
});

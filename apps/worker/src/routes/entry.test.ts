import { describe, expect, it } from 'vitest';

import { app } from '../api';
import { entryRoutes } from './entry';

describe('Authentication and entry routes', () => {
  it('exposes the health contract through its route module', async () => {
    const response = await entryRoutes.request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'ok', service: 'mail-automation' },
    });
  });

  it('is mounted by the root app at the API prefix', async () => {
    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'ok', service: 'mail-automation' },
    });
  });
});

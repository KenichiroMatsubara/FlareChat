import { describe, expect, it } from 'vitest';

import { createMigratedTestD1 } from '../../test/d1';
import { app } from '../api';
import type { Bindings } from '../types';
import { entryRoutes } from './entry';

describe('Authentication and entry routes', () => {
  it('exposes the health contract through its route module', async () => {
    const control = createMigratedTestD1('control');
    const environment = { CONTROL_DB: control.binding } as Bindings;
    const response = await entryRoutes.fetch(new Request('https://app.example.com/health'), environment);

    try {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { status: 'ok', service: 'mail-automation' },
      });
    } finally {
      control.close();
    }
  });

  it('is mounted by the root app at the API prefix', async () => {
    const control = createMigratedTestD1('control');
    const environment = { CONTROL_DB: control.binding } as Bindings;
    const response = await app.fetch(new Request('https://app.example.com/api/health'), environment);

    try {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { status: 'ok', service: 'mail-automation' },
      });
    } finally {
      control.close();
    }
  });
});

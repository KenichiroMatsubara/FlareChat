import { afterEach, describe, expect, it } from 'vitest';

import { automationRoutes } from './automation';
import { createTestApp, type TestApp } from '../../test/app';

let fixture: TestApp | undefined;

afterEach(() => fixture?.close());

describe('Organization Automation routes', () => {
  it('reads Automation Inbox behavior for the authenticated Organization', async () => {
    fixture = createTestApp();

    const response = await automationRoutes.fetch(
      fixture.request('/organizations/organization-1/automation'),
      fixture.environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { email: 'owner@example.com', displayName: 'Owner', enabled: true },
    });
  });
});

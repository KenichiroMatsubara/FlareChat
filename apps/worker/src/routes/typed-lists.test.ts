import { afterEach, describe, expect, it } from 'vitest';

import { typedListRoutes } from './typed-lists';
import { createTestApp, type TestApp } from '../../test/app';

let fixture: TestApp | undefined;

afterEach(() => fixture?.close());

describe('Typed List routes', () => {
  it('creates and lists a Typed List through the module interface', async () => {
    fixture = createTestApp('admin');

    const created = await typedListRoutes.fetch(fixture.jsonRequest(
      '/organizations/organization-1/lists',
      { kind: 'source', name: 'Members' },
    ), fixture.environment);
    const listed = await typedListRoutes.fetch(
      fixture.request('/organizations/organization-1/lists'),
      fixture.environment,
    );

    expect(created.status).toBe(201);
    await expect(listed.json()).resolves.toMatchObject({ data: [{ kind: 'source', name: 'Members' }] });
  });
});

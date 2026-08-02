import { describe, expect, it } from 'vitest';

import { app } from './api';
import { availablePresets } from './presets';
import { createTestApp } from '../test/app';

describe('Preset catalog', () => {
  it('ships exactly one self-contained JSON Preset', () => {
    expect(availablePresets()).toEqual([
      expect.objectContaining({
        id: 'membership-organization',
        typedLists: expect.arrayContaining([
          expect.objectContaining({ kind: 'recipient', items: [] }),
          expect.objectContaining({ kind: 'line', items: [] }),
        ]),
        operationalTaskRoles: expect.arrayContaining([
          expect.objectContaining({ key: 'schedule' }),
          expect.objectContaining({ key: 'treasury' }),
        ]),
        schemaRules: [expect.objectContaining({ messageSummary: expect.any(Object) })],
        agentRules: [expect.objectContaining({ promptKey: expect.any(String) })],
      }),
    ]);
  });

  it('exposes the shipped Preset metadata to setup and settings screens', async () => {
    const fixture = createTestApp();
    try {
      const response = await app.fetch(fixture.request('/api/presets'), fixture.environment);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ data: [{
        id: 'membership-organization',
        name: 'Membership organization',
        description: expect.any(String),
      }] });
    } finally {
      fixture.close();
    }
  });
});

describe('Preset application', () => {
  it('copies the complete Preset configuration into an empty Organization', async () => {
    const fixture = createTestApp();
    try {
      const applied = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      const [lists, roles, rules, prompts, agentRules] = await Promise.all([
        app.fetch(fixture.request('/api/organizations/organization-1/lists'), fixture.environment),
        app.fetch(fixture.request('/api/organizations/organization-1/task-roles'), fixture.environment),
        app.fetch(fixture.request('/api/organizations/organization-1/rules'), fixture.environment),
        app.fetch(fixture.request('/api/organizations/organization-1/prompts'), fixture.environment),
        app.fetch(fixture.request('/api/organizations/organization-1/agent-rules'), fixture.environment),
      ]);

      expect(applied.status).toBe(201);
      await expect(applied.json()).resolves.toEqual({
        data: { presetId: 'membership-organization', typedLists: 3, operationalTaskRoles: 2, prompts: 1, schemaRules: 1, agentRules: 1 },
      });
      await expect(lists.json()).resolves.toMatchObject({ data: [
        { name: 'Calendar members' },
        { name: 'LINE members' },
        { name: 'Trusted announcement sources' },
      ] });
      await expect(roles.json()).resolves.toMatchObject({ data: { roles: [
        { displayName: 'Schedule' },
        { displayName: 'Treasury' },
      ] } });
      await expect(rules.json()).resolves.toMatchObject({ data: [{
        name: 'Membership announcements',
        state: 'draft',
        taskRoleIds: [expect.any(String), expect.any(String)],
        permittedRecipientListIds: [expect.any(String)],
        permittedLineListIds: [expect.any(String)],
      }] });
      await expect(prompts.json()).resolves.toMatchObject({ data: [{ name: 'Membership assistant', revision: 1 }] });
      await expect(agentRules.json()).resolves.toMatchObject({ data: [{
        name: 'Membership follow-up', state: 'suspended', executionMode: 'approval', revision: 1,
        permittedRecipientListIds: [expect.any(String)], permittedLineListIds: [expect.any(String)],
      }] });
    } finally {
      fixture.close();
    }
  });

  it('does not retain a live link to the repository document after copying', async () => {
    const fixture = createTestApp();
    const document = availablePresets()[0]!;
    const rule = document.schemaRules[0]!;
    const originalName = rule.name;
    try {
      await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      rule.name = 'Changed in a later product release';

      const copiedRules = await app.fetch(
        fixture.request('/api/organizations/organization-1/rules'),
        fixture.environment,
      );

      await expect(copiedRules.json()).resolves.toMatchObject({ data: [{ name: originalName }] });
    } finally {
      rule.name = originalName;
      fixture.close();
    }
  });

  it('rejects existing configuration unless the member explicitly chooses to add another copy', async () => {
    const fixture = createTestApp();
    try {
      await app.fetch(fixture.jsonRequest('/api/organizations/organization-1/lists', {
        kind: 'source', name: 'Existing configuration',
      }), fixture.environment);

      const rejected = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      const beforeChoice = await app.fetch(
        fixture.request('/api/organizations/organization-1/lists'),
        fixture.environment,
      );
      const explicitlyAdded = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        { conflictPolicy: 'duplicate' },
      ), fixture.environment);
      const afterChoice = await app.fetch(
        fixture.request('/api/organizations/organization-1/lists'),
        fixture.environment,
      );

      expect(rejected.status).toBe(409);
      await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'preset_configuration_conflict' } });
      await expect(beforeChoice.json()).resolves.toMatchObject({ data: [{ name: 'Existing configuration' }] });
      expect(explicitlyAdded.status).toBe(201);
      await expect(afterChoice.json()).resolves.toMatchObject({ data: [
        { name: 'Calendar members' },
        { name: 'Existing configuration' },
        { name: 'LINE members' },
        { name: 'Trusted announcement sources' },
      ] });
    } finally {
      fixture.close();
    }
  });

  it('adds a separately named second copy only after an explicit duplicate choice', async () => {
    const fixture = createTestApp();
    try {
      await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        {},
      ), fixture.environment);
      const second = await app.fetch(fixture.jsonRequest(
        '/api/organizations/organization-1/presets/membership-organization/apply',
        { conflictPolicy: 'duplicate' },
      ), fixture.environment);
      const prompts = await app.fetch(
        fixture.request('/api/organizations/organization-1/prompts'),
        fixture.environment,
      );

      expect(second.status).toBe(201);
      await expect(prompts.json()).resolves.toMatchObject({ data: [
        { name: 'Membership assistant' },
        { name: 'Membership assistant (2)' },
      ] });
    } finally {
      fixture.close();
    }
  });
});

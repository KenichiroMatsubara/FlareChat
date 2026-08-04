import type { TestD1Database } from './d1';

const CREATED_AT = '2026-07-25T00:00:00.000Z';

export const seedOrganizationRoute = (
  control: TestD1Database,
  input: {
    id: string;
    bindingName: string;
    databaseId?: string;
    name?: string;
    status?: 'provisioning' | 'active' | 'suspended' | 'failed';
  },
): void => {
  control.execute(
    `INSERT INTO organizations
      (id, name, status, database_id, binding_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.name ?? input.id,
    input.status ?? 'active',
    input.databaseId ?? `local:${input.bindingName}`,
    input.bindingName,
    CREATED_AT,
    CREATED_AT,
  );
};

export const seedScheduledEvent = (
  organization: TestD1Database,
  input: {
    id: string;
    organizationId?: string;
    title?: string;
    startsAt?: string;
    endsAt?: string;
    attendanceDeadline?: string | null;
    status?: 'draft' | 'scheduled' | 'cancelled' | 'exception';
  },
): void => {
  const organizationId = input.organizationId ?? 'organization-1';
  const ruleId = `seed-owning-rule-${organizationId}`;
  organization.execute(
    `INSERT OR IGNORE INTO rules
      (id, organization_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'archived', ?, ?)`,
    ruleId,
    organizationId,
    'Seed Owning Rule',
    CREATED_AT,
    CREATED_AT,
  );
  organization.execute(
    `INSERT INTO events
      (id, organization_id, rule_id, title, starts_at, ends_at, status, attendance_deadline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    organizationId,
    ruleId,
    input.title ?? input.id,
    input.startsAt ?? '2099-01-01T10:00:00.000Z',
    input.endsAt ?? '2099-01-01T11:00:00.000Z',
    input.status ?? 'scheduled',
    input.attendanceDeadline ?? null,
    CREATED_AT,
    CREATED_AT,
  );
};

export const seedMember = (
  organization: TestD1Database,
  input: { id: string; name?: string; email?: string; googleSubject?: string; lineDestinationId?: string },
): void => {
  organization.execute(
    `INSERT OR IGNORE INTO members (id, organization_id, name, email, state, tags, google_subject, created_at, updated_at)
     VALUES (?, 'organization-1', ?, ?, 'active', '[]', ?, ?, ?)`,
    input.id,
    input.name ?? input.id,
    input.email ?? '',
    input.googleSubject ?? null,
    CREATED_AT,
    CREATED_AT,
  );
  if (!input.lineDestinationId) return;
  organization.execute(
    `INSERT OR IGNORE INTO connections (id, kind, label, credential, status, created_at, updated_at)
     VALUES ('line-connection', 'line', 'LINE', '{}', 'active', ?, ?)`,
    CREATED_AT,
    CREATED_AT,
  );
  organization.execute(
    `INSERT OR IGNORE INTO line_destinations (id, connection_id, destination_id, display_name, kind, status, source, discovered_at, updated_at)
     VALUES (?, 'line-connection', ?, ?, 'user', 'discovered', 'webhook', ?, ?)`,
    `line-${input.id}`,
    input.lineDestinationId,
    input.name ?? input.id,
    CREATED_AT,
    CREATED_AT,
  );
  organization.execute(
    'INSERT OR IGNORE INTO member_line_destinations (member_id, line_destination_id, created_at) VALUES (?, ?, ?)',
    input.id,
    `line-${input.id}`,
    CREATED_AT,
  );
};

export const seedAttendanceRegistration = (
  organization: TestD1Database,
  input: {
    eventId: string;
    memberId: string;
    destination: string;
    name?: string;
    googleSubject?: string;
    status?: 'unanswered' | 'attending' | 'not_attending';
  },
): void => {
  seedMember(organization, {
    id: input.memberId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.googleSubject === undefined ? {} : { googleSubject: input.googleSubject }),
    lineDestinationId: input.destination,
  });
  organization.execute(
    `INSERT INTO attendance (event_id, member_id, status, comment, updated_at)
     VALUES (?, ?, ?, '', ?)`,
    input.eventId,
    input.memberId,
    input.status ?? 'unanswered',
    CREATED_AT,
  );
};

export const seedDeliveryRecord = (
  organization: TestD1Database,
  input: {
    id: string;
    eventId?: string | null;
    destination: string;
    outcome?: 'succeeded' | 'failed' | 'pending';
    channel?: 'calendar' | 'line' | 'email' | 'drive';
    externalId?: string | null;
    createdAt: string;
  },
): void => {
  organization.execute(
    `INSERT INTO deliveries
      (id, event_id, channel, destination, outcome, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.eventId ?? null,
    input.channel ?? 'calendar',
    input.destination,
    input.outcome ?? 'succeeded',
    input.externalId ?? null,
    input.createdAt,
  );
};

export const seedAutomationRule = (
  organization: TestD1Database,
  input: { id: string; organizationId?: string; name?: string; status?: 'draft' | 'active' | 'suspended' | 'archived' },
): void => {
  organization.execute(
    `INSERT INTO rules
      (id, organization_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.id,
    input.organizationId ?? 'organization-1',
    input.name ?? input.id,
    input.status ?? 'active',
    CREATED_AT,
    CREATED_AT,
  );
};

export const seedAutomationException = (
  organization: TestD1Database,
  input: { id: string; code?: string; message?: string },
): void => {
  organization.execute(
    `INSERT INTO exceptions (id, code, message, state, created_at)
     VALUES (?, ?, ?, 'open', ?)`,
    input.id,
    input.code ?? 'test_exception',
    input.message ?? 'Test exception',
    CREATED_AT,
  );
};

export const seedOrganizationMember = (
  control: TestD1Database,
  input: {
    organizationId?: string;
    identityId: string;
    email: string;
    state?: 'active' | 'suspended' | 'removed';
    sessionId?: string;
  },
): void => {
  control.execute(
    'INSERT INTO identities (id, google_subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    input.identityId,
    `google-${input.identityId}`,
    input.email,
    input.email,
    CREATED_AT,
    CREATED_AT,
  );
  control.execute(
    'INSERT INTO admins (organization_id, identity_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    input.organizationId ?? 'organization-1',
    input.identityId,
    input.state ?? 'active',
    CREATED_AT,
    CREATED_AT,
  );
  if (input.sessionId) {
    control.execute(
      'INSERT INTO sessions (id, identity_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      input.sessionId,
      input.identityId,
      '2099-01-01T00:00:00.000Z',
      CREATED_AT,
      CREATED_AT,
    );
  }
};

export interface MemoryR2 {
  bucket: R2Bucket;
  object: (key: string) => string | undefined;
  keys: () => string[];
}

export const createMemoryR2 = (failure?: Error): MemoryR2 => {
  const objects = new Map<string, string>();
  return {
    bucket: {
      put: async (key: string, value: string | ReadableStream | ArrayBuffer | ArrayBufferView | Blob) => {
        if (failure) throw failure;
        if (typeof value !== 'string') throw new Error('The test R2 adapter accepts string objects only.');
        objects.set(key, value);
        return null;
      },
      get: async (key: string) => {
        const value = objects.get(key);
        return value === undefined ? null : { text: async () => value };
      },
    } as unknown as R2Bucket,
    object: (key) => objects.get(key),
    keys: () => [...objects.keys()],
  };
};

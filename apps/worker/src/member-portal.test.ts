import { afterEach, describe, expect, it } from 'vitest';

import { app } from './api';
import { createTestApp, type TestApp } from '../test/app';
import { seedMember, seedOrganizationMember, seedScheduledEvent } from '../test/seed';

let fixture: TestApp | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

const CREATED_AT = '2026-07-25T00:00:00.000Z';

/** A person who signed in with Google but has not yet used a portal invitation. */
const signInAsMember = (test: TestApp): void => {
  seedOrganizationMember(test.control, {
    identityId: 'identity-member',
    email: 'hanako@example.com',
    sessionId: 'session-member',
  });
  test.control.execute("DELETE FROM admins WHERE identity_id = 'identity-member'");
};

const memberRequest = (path: string, init: RequestInit = {}): Request => new Request(
  `https://app.example.com${path}`,
  { ...init, headers: { Cookie: 'mail_session=session-member', ...init.headers } },
);

const memberJsonRequest = (path: string, body: unknown, method = 'POST'): Request =>
  memberRequest(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const invitation = async (test: TestApp, memberId: string): Promise<string> => {
  const issued = await app.fetch(test.jsonRequest(
    `/api/organizations/organization-1/members/${memberId}/portal-invitations`,
    {},
  ), test.environment);
  const body = await issued.json() as { data: { portalUrl: string } };
  return body.data.portalUrl.split('/').at(-1) ?? '';
};

const seedTask = (test: TestApp, input: { id: string; title: string; memberId: string | null; name: string }): void => {
  test.organization.execute(
    `INSERT OR IGNORE INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, state)
     VALUES ('source-1', 'gmail-1', 'history-1', 'sender@example.com', '年次行事', '2026-08-01', 'processed')`,
  );
  test.organization.execute(
    `INSERT OR IGNORE INTO operational_task_roles (id, display_name, description, created_at, updated_at)
     VALUES ('role-1', '会計', '支払期限を扱う', '2026-08-01', '2026-08-01')`,
  );
  test.organization.execute(
    `INSERT INTO tasks (id, organization_id, source_message_id, source_message_subject, title, deadline,
       assignee_role_id, assignee_role_name, assignee_member_id, assignee_name, description, completed, created_at, updated_at)
     VALUES (?, 'organization-1', 'source-1', '年次行事', ?, '2026-08-20', 'role-1', '会計', ?, ?, '振込する', 0, ?, ?)`,
    input.id,
    input.title,
    input.memberId,
    input.name,
    CREATED_AT,
    CREATED_AT,
  );
};

describe('Member Portal entry', () => {
  it('refuses a portal invitation for a Member with no linked LINE Destination', async () => {
    fixture = createTestApp();
    seedMember(fixture.organization, { id: 'member-1', name: '山田花子' });

    const issued = await app.fetch(fixture.jsonRequest(
      '/api/organizations/organization-1/members/member-1/portal-invitations',
      {},
    ), fixture.environment);

    expect(issued.status).toBe(409);
  });

  it('binds the signed-in Google account on first entry and refuses the used invitation', async () => {
    fixture = createTestApp();
    seedMember(fixture.organization, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember1' });
    signInAsMember(fixture);
    const token = await invitation(fixture, 'member-1');

    const first = await app.fetch(memberJsonRequest(`/api/member-links/organization-1/${token}`, {}), fixture.environment);
    const second = await app.fetch(memberJsonRequest(`/api/member-links/organization-1/${token}`, {}), fixture.environment);

    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ data: { memberId: 'member-1', name: '山田花子' } });
    expect(second.status).toBe(410);
    expect(fixture.organization.row<{ google_subject: string }>(
      "SELECT google_subject FROM members WHERE id = 'member-1'",
    )).toEqual({ google_subject: 'google-identity-member' });
  });

  it('refuses an invitation the Google account of another Member already used', async () => {
    fixture = createTestApp();
    seedMember(fixture.organization, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember1' });
    seedMember(fixture.organization, { id: 'member-2', name: '鈴木一郎', lineDestinationId: 'Umember2' });
    signInAsMember(fixture);
    await app.fetch(memberJsonRequest(
      `/api/member-links/organization-1/${await invitation(fixture, 'member-1')}`,
      {},
    ), fixture.environment);

    const second = await app.fetch(memberJsonRequest(
      `/api/member-links/organization-1/${await invitation(fixture, 'member-2')}`,
      {},
    ), fixture.environment);

    expect(second.status).toBe(410);
  });

  it('turns away a signed-in account that was never brought in through an invitation', async () => {
    fixture = createTestApp();
    signInAsMember(fixture);

    const portal = await app.fetch(memberRequest('/api/portal'), fixture.environment);

    expect(portal.status).toBe(403);
  });

  it('requires a session before an invitation can bind anyone', async () => {
    fixture = createTestApp();
    seedMember(fixture.organization, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember1' });
    const token = await invitation(fixture, 'member-1');

    const anonymous = await app.fetch(new Request(
      `https://app.example.com/api/member-links/organization-1/${token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    ), fixture.environment);

    expect(anonymous.status).toBe(401);
  });
});

describe('Member Portal', () => {
  const enterPortal = async (test: TestApp): Promise<void> => {
    seedMember(test.organization, { id: 'member-1', name: '山田花子', lineDestinationId: 'Umember1' });
    signInAsMember(test);
    await app.fetch(memberJsonRequest(
      `/api/member-links/organization-1/${await invitation(test, 'member-1')}`,
      {},
    ), test.environment);
  };

  it('carries both attendance registration and every Task, marking the ones this Member may complete', async () => {
    fixture = createTestApp();
    await enterPortal(fixture);
    seedMember(fixture.organization, { id: 'member-2', name: '鈴木一郎' });
    seedScheduledEvent(fixture.organization, {
      id: 'event-1',
      title: '年次総会',
      startsAt: '2026-08-10T10:00:00.000Z',
      endsAt: '2026-08-10T12:00:00.000Z',
      attendanceDeadline: '2026-08-08T00:00:00.000Z',
    });
    fixture.organization.execute(
      "INSERT INTO attendance (event_id, member_id, status, comment, updated_at) VALUES ('event-1', 'member-1', 'unanswered', '', ?)",
      CREATED_AT,
    );
    seedTask(fixture, { id: 'task-mine', title: '参加費を振り込む', memberId: 'member-1', name: '山田花子' });
    seedTask(fixture, { id: 'task-theirs', title: '会場を予約する', memberId: 'member-2', name: '鈴木一郎' });

    const portal = await app.fetch(memberRequest('/api/portal'), fixture.environment);

    expect(portal.status).toBe(200);
    await expect(portal.json()).resolves.toMatchObject({
      data: {
        organization: { organizationId: 'organization-1', name: 'Organization One' },
        member: { memberId: 'member-1', name: '山田花子' },
        events: [{ eventId: 'event-1', title: '年次総会', status: 'unanswered', open: true }],
        tasks: [
          { taskId: 'task-mine', title: '参加費を振り込む', mine: true },
          { taskId: 'task-theirs', title: '会場を予約する', mine: false },
        ],
      },
    });
  });

  it('registers attendance with a comment until the Registration Deadline, then locks it', async () => {
    fixture = createTestApp();
    await enterPortal(fixture);
    seedScheduledEvent(fixture.organization, {
      id: 'event-open',
      endsAt: '2026-08-10T12:00:00.000Z',
      attendanceDeadline: '2026-08-08T00:00:00.000Z',
    });
    seedScheduledEvent(fixture.organization, {
      id: 'event-closed',
      endsAt: '2026-08-10T12:00:00.000Z',
      attendanceDeadline: '2026-07-30T00:00:00.000Z',
    });
    for (const eventId of ['event-open', 'event-closed']) {
      fixture.organization.execute(
        'INSERT INTO attendance (event_id, member_id, status, comment, updated_at) VALUES (?, ?, ?, ?, ?)',
        eventId,
        'member-1',
        'unanswered',
        '',
        CREATED_AT,
      );
    }

    const answered = await app.fetch(memberJsonRequest(
      '/api/portal/events/event-open/attendance',
      { status: 'attending', comment: '参加します' },
      'PUT',
    ), fixture.environment);
    const locked = await app.fetch(memberJsonRequest(
      '/api/portal/events/event-closed/attendance',
      { status: 'attending' },
      'PUT',
    ), fixture.environment);

    expect(answered.status).toBe(200);
    expect(locked.status).toBe(409);
    expect(fixture.organization.row<{ status: string; comment: string }>(
      "SELECT status, comment FROM attendance WHERE event_id = 'event-open'",
    )).toEqual({ status: 'attending', comment: '参加します' });
  });

  it('refuses attendance for an event this Member is not an Eligible Recipient of', async () => {
    fixture = createTestApp();
    await enterPortal(fixture);
    seedScheduledEvent(fixture.organization, {
      id: 'event-other',
      endsAt: '2026-08-10T12:00:00.000Z',
      attendanceDeadline: '2026-08-08T00:00:00.000Z',
    });

    const response = await app.fetch(memberJsonRequest(
      '/api/portal/events/event-other/attendance',
      { status: 'attending' },
      'PUT',
    ), fixture.environment);

    expect(response.status).toBe(409);
  });

  it('completes only the Tasks assigned to this Member', async () => {
    fixture = createTestApp();
    await enterPortal(fixture);
    seedMember(fixture.organization, { id: 'member-2', name: '鈴木一郎' });
    seedTask(fixture, { id: 'task-mine', title: '参加費を振り込む', memberId: 'member-1', name: '山田花子' });
    seedTask(fixture, { id: 'task-theirs', title: '会場を予約する', memberId: 'member-2', name: '鈴木一郎' });

    const mine = await app.fetch(memberJsonRequest(
      '/api/portal/tasks/task-mine',
      { completed: true, remarks: '振込済み' },
      'PATCH',
    ), fixture.environment);
    const theirs = await app.fetch(memberJsonRequest(
      '/api/portal/tasks/task-theirs',
      { completed: true },
      'PATCH',
    ), fixture.environment);

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(403);
    expect(fixture.organization.rows<{ id: string; completed: number }>(
      'SELECT id, completed FROM tasks ORDER BY id',
    )).toEqual([
      { id: 'task-mine', completed: 1 },
      { id: 'task-theirs', completed: 0 },
    ]);
  });
});

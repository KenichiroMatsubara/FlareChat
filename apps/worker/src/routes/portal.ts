import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDatabaseAccess } from '../database-access';
import {
  bindMemberToGoogleAccount,
  completeOwnTask,
  memberForGoogleSubject,
  portalView,
  registerAttendance,
  type PortalMember,
} from '../member-portal';
import { failure, json } from '../response';
import { createRequestContext } from './request-context';
import { controlDatabase, organizationDatabase } from '../storage/database';
import { identities, memberLogins, organizations } from '../storage/control-schema';
import type { Bindings, SessionRow } from '../types';
import type { OrganizationDatabase } from '../storage/database';

export const portalRoutes = new Hono<{ Bindings: Bindings }>();

const now = (): string => new Date().toISOString();

interface PortalOrganization {
  organizationId: string;
  name: string;
  database: OrganizationDatabase;
}

const googleSubjectOf = async (env: Bindings, session: SessionRow): Promise<string> => {
  const identity = await controlDatabase(env.CONTROL_DB).select({ googleSubject: identities.googleSubject })
    .from(identities).where(eq(identities.id, session.identity_id)).get();
  if (!identity) throw new Error('Authentication is required.');
  return identity.googleSubject;
};

const activeOrganization = async (env: Bindings, organizationId: string): Promise<PortalOrganization> => {
  const organization = await controlDatabase(env.CONTROL_DB).select({
    organizationId: organizations.id,
    name: organizations.name,
    databaseId: organizations.databaseId,
    bindingName: organizations.bindingName,
  }).from(organizations).where(and(eq(organizations.id, organizationId), eq(organizations.status, 'active'))).get();
  if (!organization) throw new Error('この組織は現在利用できません。');
  const opened = await createDatabaseAccess(env).open({
    kind: 'organization',
    bindingName: organization.bindingName,
    databaseId: organization.databaseId,
  });
  return {
    organizationId: organization.organizationId,
    name: organization.name,
    database: organizationDatabase(opened.raw),
  };
};

/** Resolves the Portal a signed-in Google account reaches, through Control D1 routing. */
const portalAccess = async (env: Bindings, session: SessionRow): Promise<{
  organization: PortalOrganization;
  member: PortalMember;
  googleSubject: string;
}> => {
  const googleSubject = await googleSubjectOf(env, session);
  const login = await controlDatabase(env.CONTROL_DB).select({ organizationId: memberLogins.organizationId })
    .from(memberLogins).where(eq(memberLogins.googleSubject, googleSubject)).get();
  if (!login) throw new Error('このアカウントはメンバーとして登録されていません。');
  const organization = await activeOrganization(env, login.organizationId);
  const member = await memberForGoogleSubject(organization.database, googleSubject);
  if (!member) throw new Error('このアカウントはメンバーとして登録されていません。');
  return { organization, member, googleSubject };
};

const sessionOf = async (request: Request, env: Bindings): Promise<SessionRow> => {
  const session = await createRequestContext(request, env).session();
  if (!session) throw new Error('Authentication is required.');
  return session;
};

portalRoutes.post('/member-links/:organizationId/:token', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const organization = await activeOrganization(context.env, context.req.param('organizationId'));
    const member = await bindMemberToGoogleAccount({
      control: controlDatabase(context.env.CONTROL_DB),
      database: organization.database,
      organizationId: organization.organizationId,
      token: context.req.param('token'),
      googleSubject: await googleSubjectOf(context.env, session),
      now: now(),
    });
    return json(context, { organizationId: organization.organizationId, ...member }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Member Link could not be used.';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 410);
  }
});

portalRoutes.get('/portal', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const { organization, member } = await portalAccess(context.env, session);
    return json(context, {
      organization: { organizationId: organization.organizationId, name: organization.name },
      ...await portalView({ database: organization.database, member, now: now() }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Member Portal could not be loaded.';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

portalRoutes.put('/portal/events/:eventId/attendance', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const { organization, member } = await portalAccess(context.env, session);
    const input = await context.req.json<{ status?: string; comment?: string }>();
    if (!['unanswered', 'attending', 'not_attending'].includes(input.status ?? '')) {
      return failure(context, '出欠の回答を選んでください。');
    }
    const comment = input.comment?.trim() ?? '';
    if (comment.length > 1_000) return failure(context, 'コメントが長すぎます。');
    return json(context, await registerAttendance({
      database: organization.database,
      member,
      eventId: context.req.param('eventId'),
      status: input.status as 'unanswered' | 'attending' | 'not_attending',
      comment,
      now: now(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '出欠を登録できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 409);
  }
});

portalRoutes.patch('/portal/tasks/:taskId', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const { organization, member } = await portalAccess(context.env, session);
    const input = await context.req.json<{ completed?: unknown; remarks?: unknown }>();
    if (input.completed !== undefined && typeof input.completed !== 'boolean') return failure(context, '完了状態が不正です。');
    if (input.remarks !== undefined && typeof input.remarks !== 'string') return failure(context, '備考が不正です。');
    return json(context, await completeOwnTask({
      database: organization.database,
      member,
      taskId: context.req.param('taskId'),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
      ...(input.remarks === undefined ? {} : { remarks: input.remarks.trim() }),
      now: now(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'タスクを更新できませんでした。';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

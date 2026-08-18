import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createDatabaseAccess } from '../database-access';
import {
  bindContactToGoogleAccount,
  completeOwnTask,
  contactForGoogleSubject,
  portalView,
  registerAttendance,
  type PortalContact,
} from '../contact-portal';
import { failure, json } from '../response';
import { createRequestContext } from './request-context';
import { controlDatabase, accountDatabase } from '../storage/database';
import { identities, contactLogins, accounts } from '../storage/control-schema';
import type { Bindings, SessionRow } from '../types';
import type { AccountDatabase } from '../storage/database';

export const portalRoutes = new Hono<{ Bindings: Bindings }>();

const now = (): string => new Date().toISOString();

interface PortalAccount {
  accountId: string;
  name: string;
  database: AccountDatabase;
}

const googleSubjectOf = async (env: Bindings, session: SessionRow): Promise<string> => {
  const identity = await controlDatabase(env.CONTROL_DB).select({ googleSubject: identities.googleSubject })
    .from(identities).where(eq(identities.id, session.identity_id)).get();
  if (!identity) throw new Error('Authentication is required.');
  return identity.googleSubject;
};

const activeAccount = async (env: Bindings, accountId: string): Promise<PortalAccount> => {
  const account = await controlDatabase(env.CONTROL_DB).select({
    accountId: accounts.id,
    name: accounts.name,
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.status, 'active'))).get();
  if (!account) throw new Error('この組織は現在利用できません。');
  const opened = await createDatabaseAccess(env).open({
    kind: 'organization',
    bindingName: account.bindingName,
    databaseId: account.databaseId,
  });
  return {
    accountId: account.accountId,
    name: account.name,
    database: accountDatabase(opened.raw),
  };
};

/** Resolves the Portal a signed-in Google account reaches, through Control D1 routing. */
const portalAccess = async (env: Bindings, session: SessionRow): Promise<{
  account: PortalAccount;
  contact: PortalContact;
  googleSubject: string;
}> => {
  const googleSubject = await googleSubjectOf(env, session);
  const login = await controlDatabase(env.CONTROL_DB).select({ accountId: contactLogins.accountId })
    .from(contactLogins).where(eq(contactLogins.googleSubject, googleSubject)).get();
  if (!login) throw new Error('このアカウントはメンバーとして登録されていません。');
  const account = await activeAccount(env, login.accountId);
  const contact = await contactForGoogleSubject(account.database, googleSubject);
  if (!contact) throw new Error('このアカウントはメンバーとして登録されていません。');
  return { account, contact, googleSubject };
};

const sessionOf = async (request: Request, env: Bindings): Promise<SessionRow> => {
  const session = await createRequestContext(request, env).session();
  if (!session) throw new Error('Authentication is required.');
  return session;
};

portalRoutes.post('/member-links/:accountId/:token', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const account = await activeAccount(context.env, context.req.param('accountId'));
    const contact = await bindContactToGoogleAccount({
      control: controlDatabase(context.env.CONTROL_DB),
      database: account.database,
      accountId: account.accountId,
      token: context.req.param('token'),
      googleSubject: await googleSubjectOf(context.env, session),
      now: now(),
    });
    return json(context, { accountId: account.accountId, ...contact }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contact Link could not be used.';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 410);
  }
});

portalRoutes.get('/portal', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const { account, contact } = await portalAccess(context.env, session);
    return json(context, {
      account: { accountId: account.accountId, name: account.name },
      ...await portalView({ database: account.database, contact, now: now() }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contact Portal could not be loaded.';
    return failure(context, message, message === 'Authentication is required.' ? 401 : 403);
  }
});

portalRoutes.put('/portal/events/:eventId/attendance', async (context) => {
  try {
    const session = await sessionOf(context.req.raw, context.env);
    const { account, contact } = await portalAccess(context.env, session);
    const input = await context.req.json<{ status?: string; comment?: string }>();
    if (!['unanswered', 'attending', 'not_attending'].includes(input.status ?? '')) {
      return failure(context, '出欠の回答を選んでください。');
    }
    const comment = input.comment?.trim() ?? '';
    if (comment.length > 1_000) return failure(context, 'コメントが長すぎます。');
    return json(context, await registerAttendance({
      database: account.database,
      contact,
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
    const { account, contact } = await portalAccess(context.env, session);
    const input = await context.req.json<{ completed?: unknown; remarks?: unknown }>();
    if (input.completed !== undefined && typeof input.completed !== 'boolean') return failure(context, '完了状態が不正です。');
    if (input.remarks !== undefined && typeof input.remarks !== 'string') return failure(context, '備考が不正です。');
    return json(context, await completeOwnTask({
      database: account.database,
      contact,
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

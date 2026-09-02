import { and, eq } from 'drizzle-orm';

import { now } from '../clock';
import {
  bindContactToGoogleAccount,
  completeOwnTask,
  contactForGoogleSubject,
  portalView,
  registerAttendance,
  type PortalContact,
} from '../contact-portal';
import { createDatabaseAccess } from '../database-access';
import { accountUnavailable, invalid, noAccess, unauthenticated } from '../refusal';
import { resource } from '../response';
import { createRequestContext } from './request-context';
import { controlDatabase, accountDatabase, type AccountDatabase } from '../storage/database';
import { identities, contactLogins, accounts } from '../storage/control-schema';
import type { Bindings, SessionRow } from '../types';

/** The Contact Portal keeps its own session model (ADR 0155) and refuses with the same type as every other route. */
export const portalRoutes = resource();

interface PortalAccount {
  accountId: string;
  name: string;
  database: AccountDatabase;
}

const googleSubjectOf = async (env: Bindings, session: SessionRow): Promise<string> => {
  const identity = await controlDatabase(env.CONTROL_DB).select({ googleSubject: identities.googleSubject })
    .from(identities).where(eq(identities.id, session.identity_id)).get();
  if (!identity) throw unauthenticated();
  return identity.googleSubject;
};

const activeAccount = async (env: Bindings, accountId: string): Promise<PortalAccount> => {
  const account = await controlDatabase(env.CONTROL_DB).select({
    accountId: accounts.id,
    name: accounts.name,
    databaseId: accounts.databaseId,
    bindingName: accounts.bindingName,
  }).from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.status, 'active'))).get();
  if (!account) throw accountUnavailable('この組織は現在利用できません。');
  const opened = await createDatabaseAccess(env).open({
    kind: 'organization',
    bindingName: account.bindingName,
    databaseId: account.databaseId,
  });
  return { accountId: account.accountId, name: account.name, database: accountDatabase(opened.raw) };
};

/** Resolves the Portal a signed-in Google account reaches, through Control D1 routing. */
const portalAccess = async (env: Bindings, session: SessionRow): Promise<{ account: PortalAccount; contact: PortalContact }> => {
  const googleSubject = await googleSubjectOf(env, session);
  const login = await controlDatabase(env.CONTROL_DB).select({ accountId: contactLogins.accountId })
    .from(contactLogins).where(eq(contactLogins.googleSubject, googleSubject)).get();
  if (!login) throw noAccess('このアカウントはメンバーとして登録されていません。');
  const account = await activeAccount(env, login.accountId);
  const contact = await contactForGoogleSubject(account.database, googleSubject);
  if (!contact) throw noAccess('このアカウントはメンバーとして登録されていません。');
  return { account, contact };
};

const sessionOf = (request: Request, env: Bindings): Promise<SessionRow> =>
  createRequestContext(request, env).requiredSession();

portalRoutes.post('/member-links/:accountId/:token', async (context) => {
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
  return context.json({ data: { accountId: account.accountId, ...contact } }, 201);
});

portalRoutes.get('/portal', async (context) => {
  const session = await sessionOf(context.req.raw, context.env);
  const { account, contact } = await portalAccess(context.env, session);
  return context.json({ data: {
    account: { accountId: account.accountId, name: account.name },
    ...await portalView({ database: account.database, contact, now: now() }),
  } });
});

portalRoutes.put('/portal/events/:eventId/attendance', async (context) => {
  const session = await sessionOf(context.req.raw, context.env);
  const { account, contact } = await portalAccess(context.env, session);
  const input = await context.req.json<{ status?: string; comment?: string }>();
  if (!['unanswered', 'attending', 'not_attending'].includes(input.status ?? '')) throw invalid('出欠の回答を選んでください。');
  const comment = input.comment?.trim() ?? '';
  if (comment.length > 1_000) throw invalid('コメントが長すぎます。');
  return context.json({ data: await registerAttendance({
    database: account.database,
    contact,
    eventId: context.req.param('eventId'),
    status: input.status as 'unanswered' | 'attending' | 'not_attending',
    comment,
    now: now(),
  }) });
});

portalRoutes.patch('/portal/tasks/:taskId', async (context) => {
  const session = await sessionOf(context.req.raw, context.env);
  const { account, contact } = await portalAccess(context.env, session);
  const input = await context.req.json<{ completed?: unknown; remarks?: unknown }>();
  if (input.completed !== undefined && typeof input.completed !== 'boolean') throw invalid('完了状態が不正です。');
  if (input.remarks !== undefined && typeof input.remarks !== 'string') throw invalid('備考が不正です。');
  return context.json({ data: await completeOwnTask({
    database: account.database,
    contact,
    taskId: context.req.param('taskId'),
    ...(input.completed === undefined ? {} : { completed: input.completed }),
    ...(input.remarks === undefined ? {} : { remarks: input.remarks.trim() }),
    now: now(),
  }) });
});

import { asc, eq } from 'drizzle-orm';

import { now } from '../clock';
import { invalid, notFound } from '../refusal';
import { resource } from '../response';
import { promptRevisions, prompts } from '../storage/account-schema';
import { accountRoute, created } from './account';

export const promptRoutes = resource();

const NAME_LIMIT = 100;
const INSTRUCTIONS_LIMIT = 100_000;

promptRoutes.get('/organizations/:accountId/prompts', accountRoute(async (request) => {
  const rows = await request.db.select().from(prompts).orderBy(asc(prompts.name)).all();
  return rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    instructions: row.instructions,
    revision: row.currentRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}));

promptRoutes.post('/organizations/:accountId/prompts', accountRoute<{ name?: string; instructions?: string }>(async (request) => {
  const name = request.body.name?.trim() ?? '';
  const instructions = request.body.instructions?.trim() ?? '';
  if (!name || name.length > NAME_LIMIT) throw invalid('A Prompt name of at most 100 characters is required.');
  if (!instructions || instructions.length > INSTRUCTIONS_LIMIT) throw invalid('Prompt instructions of at most 100000 characters are required.');
  const id = crypto.randomUUID();
  const timestamp = now();
  await request.db.batch([
    request.db.insert(prompts).values({ id, accountId: request.accountId, name, instructions, currentRevision: 1, createdAt: timestamp, updatedAt: timestamp }),
    request.db.insert(promptRevisions).values({ promptId: id, revision: 1, instructions, createdAt: timestamp }),
  ]);
  return created({ id, accountId: request.accountId, name, instructions, revision: 1, createdAt: timestamp, updatedAt: timestamp });
}));

promptRoutes.patch('/organizations/:accountId/prompts/:promptId', accountRoute<{ name?: string; instructions?: string }>(async (request) => {
  const name = request.body.name?.trim();
  const instructions = request.body.instructions?.trim();
  if (name === undefined && instructions === undefined) throw invalid('A Prompt name or instructions is required.');
  if (name !== undefined && (!name || name.length > NAME_LIMIT)) throw invalid('A Prompt name of at most 100 characters is required.');
  if (instructions !== undefined && (!instructions || instructions.length > INSTRUCTIONS_LIMIT)) throw invalid('Prompt instructions of at most 100000 characters are required.');
  const promptId = request.params.promptId ?? '';
  const existing = await request.db.select().from(prompts).where(eq(prompts.id, promptId)).get();
  if (!existing) throw notFound('Prompt was not found.');
  const revision = instructions === undefined ? existing.currentRevision : existing.currentRevision + 1;
  const timestamp = now();
  await request.db.batch([
    request.db.update(prompts).set({
      ...(name === undefined ? {} : { name }),
      ...(instructions === undefined ? {} : { instructions, currentRevision: revision }),
      updatedAt: timestamp,
    }).where(eq(prompts.id, promptId)),
    ...(instructions === undefined ? [] : [request.db.insert(promptRevisions).values({ promptId, revision, instructions, createdAt: timestamp })]),
  ]);
  return { id: promptId, ...(name === undefined ? {} : { name }), ...(instructions === undefined ? {} : { instructions }), revision, updatedAt: timestamp };
}));

promptRoutes.delete('/organizations/:accountId/prompts/:promptId', accountRoute(async (request) => {
  const promptId = request.params.promptId ?? '';
  const removed = await request.db.delete(prompts).where(eq(prompts.id, promptId)).returning({ id: prompts.id }).get();
  if (!removed) throw notFound('Prompt was not found.');
  return { id: promptId, removed: true };
}));

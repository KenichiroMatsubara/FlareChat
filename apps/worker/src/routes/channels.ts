import { channelCredentials, LINE_BATCH_LIMIT, reachableContacts, sendOnChannel } from '../channel';
import { now } from '../clock';
import { invalid } from '../refusal';
import { resource } from '../response';
import { accountRoute } from './account';

export const channelRoutes = resource();

channelRoutes.get('/organizations/:accountId/channel-tests/targets', accountRoute(async ({ database }) => {
  const reachable = await reachableContacts({ database });
  return reachable.filter((contact) => contact.channels.length > 0);
}));

/**
 * Sending one arbitrary message as a test (ADR 0158).
 *
 * An operator states a Contact, a Channel and a text, and the message travels the
 * same seam an Automation and the MCP Server send through, so a test that
 * arrives proves the production path and not a second one written for testing.
 * Repeat suppression is not consulted, because a test whose second run silently
 * sends nothing would report the Channel as working when it never spoke. Several
 * messages may be stated, so an operator can watch LINE's five-per-request batch
 * happen instead of taking it on trust.
 */
channelRoutes.post('/organizations/:accountId/channel-tests', accountRoute<{ contactId?: string; channel?: string; texts?: unknown }>(async (request) => {
  const contactId = request.body.contactId?.trim() ?? '';
  const channel = request.body.channel?.trim() ?? '';
  const texts = Array.isArray(request.body.texts) ? request.body.texts.filter((text): text is string => typeof text === 'string') : [];
  const said = texts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (!contactId) throw invalid('送信先の Contact を選んでください。');
  if (!said.length || said.length > LINE_BATCH_LIMIT) throw invalid(`テストは 1 回に 1〜${LINE_BATCH_LIMIT} 通まで送れます。`);
  if (said.some((text) => text.length > 1_000)) throw invalid('テストメッセージは 1 通 1,000 文字以内で入力してください。');
  const delivery = await sendOnChannel({
    database: request.database,
    credentials: await channelCredentials({ database: request.database, accountKey: await request.key(), accountId: request.accountId }),
    contactId,
    channel,
    texts: said,
  });
  return { ...delivery, sentAt: now() };
}));

import { now } from '../clock';
import { activeConnection, readConnection, saveConnection } from '../connections';
import { discordHandleFromInteraction, discordReply, verifyDiscordSignature, type DiscordInteraction } from '../discord';
import { invalid } from '../refusal';
import { resource } from '../response';
import { channelHandles } from '../storage/account-schema';
import { accountRoute, publicAccount } from './account';

export const discordRoutes = resource();

discordRoutes.put('/organizations/:accountId/connections/discord', accountRoute<{ botToken?: string; applicationPublicKey?: string }>(async (request) => {
  const botToken = request.body.botToken?.trim() ?? '';
  const applicationPublicKey = request.body.applicationPublicKey?.trim().toLowerCase() ?? '';
  if (!botToken) throw invalid('Discord の Bot トークンを入力してください。');
  if (!/^[0-9a-f]{64}$/u.test(applicationPublicKey)) throw invalid('Discord のアプリケーション公開鍵は 64 文字の16進数です。');
  await saveConnection({
    db: request.db,
    key: await request.key(),
    accountId: request.accountId,
    kind: 'discord',
    label: 'Discord',
    credential: { botToken, applicationPublicKey },
  });
  return {
    configured: true,
    interactionsUrl: `${request.env.APP_URL.replace(/\/$/u, '')}/api/public/organizations/${encodeURIComponent(request.accountId)}/discord/interactions`,
  };
}));

/**
 * Discord's Interactions endpoint. Workers cannot hold the Gateway connection a
 * bot normally reads messages on, so this is where an Account's people reach it,
 * and a Channel Handle is discovered from the interaction that arrives. Discord
 * reads plain text on failure, so this route answers for itself.
 */
discordRoutes.post('/public/organizations/:accountId/discord/interactions', async (context) => {
  const accountId = context.req.param('accountId');
  const body = await context.req.text();
  const signature = context.req.header('X-Signature-Ed25519') ?? '';
  const timestamp = context.req.header('X-Signature-Timestamp') ?? '';
  try {
    const account = await publicAccount(context.env, accountId, 'Discord interactions endpoint').catch(() => null);
    if (!account) return context.text('unavailable', 503);
    const credential = await readConnection({ db: account.db, key: await account.key(), accountId, kind: 'discord' });
    if (!credential.applicationPublicKey) return context.text('not configured', 503);
    const verified = await verifyDiscordSignature({ publicKey: credential.applicationPublicKey, signature, timestamp, body });
    if (!verified) return context.text('invalid request signature', 401);

    const interaction = JSON.parse(body || '{}') as DiscordInteraction;
    const handle = discordHandleFromInteraction(interaction);
    if (handle) {
      const connection = await activeConnection(account.db, 'discord');
      if (connection) {
        const stamp = now();
        await account.db.insert(channelHandles).values({
          id: crypto.randomUUID(),
          contactId: null,
          channel: 'discord',
          connectionId: connection.id,
          externalId: handle.externalId,
          replyTarget: handle.channelId,
          kind: handle.kind,
          displayName: handle.displayName,
          source: 'inbound',
          isPrimary: true,
          createdAt: stamp,
          updatedAt: stamp,
        }).onConflictDoUpdate({
          target: [channelHandles.channel, channelHandles.connectionId, channelHandles.externalId],
          set: { replyTarget: handle.channelId, displayName: handle.displayName, updatedAt: stamp },
        }).run();
      }
    }
    return context.json(discordReply(interaction));
  } catch (error) {
    return context.text(error instanceof Error ? error.message : 'discord interaction failed', 503);
  }
});

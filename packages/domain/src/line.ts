export interface LineMessage {
  destinationId: string;
  messageId: string;
  body: string;
}

export interface LineBatch {
  destinationId: string;
  messages: LineMessage[];
}

export interface LineDestination {
  kind: 'user' | 'group' | 'room';
  destinationId: string;
}

interface LineWebhookEvent {
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
}

const LINE_MESSAGE_LIMIT = 5;

/** Verifies LINE's HMAC-SHA256 webhook signature without parsing untrusted JSON first. */
export const verifyLineWebhookSignature = async (channelSecret: string, rawBody: string, signature: string): Promise<boolean> => {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
    const encoded = atob(signature);
    const received = Uint8Array.from(encoded, (character) => character.charCodeAt(0));
    if (received.byteLength !== expected.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < expected.byteLength; index += 1) difference |= expected[index]! ^ received[index]!;
    return difference === 0;
  } catch {
    return false;
  }
};

/** Extracts destinations from an already signature-verified LINE webhook body. */
export const discoveredLineDestinations = (payload: { events?: LineWebhookEvent[] }): LineDestination[] => {
  const destinations: LineDestination[] = [];
  const seen = new Set<string>();
  const add = (kind: LineDestination['kind'], destinationId: string | undefined): void => {
    if (!destinationId || seen.has(`${kind}:${destinationId}`)) return;
    seen.add(`${kind}:${destinationId}`);
    destinations.push({ kind, destinationId });
  };
  for (const event of payload.events ?? []) {
    const source = event.source;
    if (!source || !['user', 'group', 'room'].includes(source.type ?? '')) continue;
    const kind = source.type as LineDestination['kind'];
    const destinationId = kind === 'user' ? source.userId : kind === 'group' ? source.groupId : source.roomId;
    add(kind, destinationId);
    if (kind !== 'user') add('user', source.userId);
  }
  return destinations;
};

export const batchLineMessages = (messages: LineMessage[]): LineBatch[] => {
  const batches: LineBatch[] = [];
  const currentByDestination = new Map<string, LineBatch>();

  for (const message of messages) {
    const current = currentByDestination.get(message.destinationId);
    if (current && current.messages.length < LINE_MESSAGE_LIMIT) {
      current.messages.push(message);
      continue;
    }

    const batch = { destinationId: message.destinationId, messages: [message] };
    batches.push(batch);
    currentByDestination.set(message.destinationId, batch);
  }

  return batches;
};

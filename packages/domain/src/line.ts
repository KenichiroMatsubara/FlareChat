export interface LineMessage {
  destinationId: string;
  messageId: string;
  body: string;
}

export interface LineBatch {
  destinationId: string;
  messages: LineMessage[];
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

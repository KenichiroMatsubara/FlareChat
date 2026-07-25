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

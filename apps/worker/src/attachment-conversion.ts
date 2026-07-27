import { normalizeAttachments, type AttachmentContent } from './normalization';

/** Limits converted attachment text included with one Gemini event-extraction request. */
export const MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS = 4_000;
export const MAX_EVENT_EXTRACTION_ATTACHMENT_CHARS = 16_000;
const MAX_CONVERSION_CHUNK_CHARS = 1_200;

export interface MarkdownConversionResult {
  format: 'markdown' | 'text' | 'error';
  name: string;
  mimetype: string;
  tokens?: number;
  data?: string;
  error?: string;
}

/** The narrow Workers AI seam needed by attachment conversion. */
export interface MarkdownConverter {
  toMarkdown(document: { name: string; blob: Blob }): Promise<MarkdownConversionResult>;
}

export interface ConvertedAttachment {
  attachmentId: string;
  filename: string;
  originalMimeType: string;
  /** Workers AI's conversion estimate (or the local fallback estimate). */
  text: string;
  tokens: number;
  /** The portion of `tokens` admitted to this Gemini extraction request. */
  selectedTokens: number;
  converter: 'workers_ai' | 'local_office';
}

const localOfficeMimeTypes = new Set([
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const decodedBase64 = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error('Attachment data is not valid base64.');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
};

const attachmentBlob = (attachment: AttachmentContent): Blob => {
  const bytes = decodedBase64(attachment.data);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: attachment.mimeType });
};

const eventSignal = /(?:\b20\d{2}[/-]\d{1,2}[/-]\d{1,2}\b|\d{1,2}:\d{2}|\d{1,2}時|日時|日付|開始|終了|会場|場所|所在地|title|date|time|venue|location)/iu;

const hasEventSignal = (text: string): boolean => eventSignal.test(text);

const chunks = (text: string): string[] => text
  .split(/\n\s*\n/u)
  .flatMap((paragraph) => paragraph.match(new RegExp(`.{1,${MAX_CONVERSION_CHUNK_CHARS}}(?:\\s|$)`, 'gu')) ?? [paragraph])
  .map((chunk) => chunk.trim())
  .filter(Boolean);

/** Keeps event-bearing conversion chunks and their immediate context within the input budget. */
export const eventRelevantText = (text: string, tokens: number): string => {
  const documentChunks = chunks(text);
  const selected = new Set<number>();
  documentChunks.forEach((chunk, index) => {
    if (!eventSignal.test(chunk)) return;
    selected.add(index);
    if (index > 0) selected.add(index - 1);
    if (index + 1 < documentChunks.length) selected.add(index + 1);
  });
  if (!selected.size && documentChunks.length) selected.add(0);
  const ratio = Math.min(1, MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS / tokens);
  const characterBudget = Math.min(
    MAX_EVENT_EXTRACTION_ATTACHMENT_CHARS,
    Math.max(1, Math.ceil(text.length * ratio)),
  );
  let remaining = characterBudget;
  const result: string[] = [];
  for (const index of [...selected].sort((first, second) => first - second)) {
    if (!remaining) break;
    const chunk = documentChunks[index] ?? '';
    result.push(chunk.slice(0, remaining));
    remaining -= chunk.length;
  }
  return result.join('\n\n').trim();
};

const localOfficeFallback = (attachment: AttachmentContent): ConvertedAttachment => {
  const normalized = normalizeAttachments([attachment])[0];
  if (!normalized || normalized.kind !== 'text') throw new Error(`${attachment.filename} をローカルで正規化できませんでした。`);
  const tokens = Math.ceil(normalized.text.length / 4);
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text: eventRelevantText(normalized.text, tokens),
    tokens,
    selectedTokens: Math.min(tokens, MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS),
    converter: 'local_office',
  };
};

const convertedAttachment = async (
  attachment: AttachmentContent,
  markdown: MarkdownConverter,
): Promise<ConvertedAttachment> => {
  const result = await markdown.toMarkdown({
    name: attachment.filename,
    blob: attachmentBlob(attachment),
  });
  if (result.format === 'error') throw new Error(result.error || `${attachment.filename} を変換できませんでした。`);
  if (!result.tokens || result.tokens < 1 || !result.data?.trim()) {
    throw new Error(`${attachment.filename} の変換結果が空です。`);
  }
  if (!hasEventSignal(result.data)) {
    throw new Error(`${attachment.filename} の変換結果に予定抽出に必要な情報がありません。`);
  }
  const text = eventRelevantText(result.data, result.tokens);
  if (!text) throw new Error(`${attachment.filename} から予定抽出に必要なテキストを選別できませんでした。`);
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text,
    tokens: result.tokens,
    selectedTokens: Math.min(result.tokens, MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS),
    converter: 'workers_ai',
  };
};

const boundConvertedAttachments = (attachments: ConvertedAttachment[]): ConvertedAttachment[] => {
  const totalTokens = attachments.reduce((total, attachment) => total + attachment.selectedTokens, 0);
  let remaining = MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS;
  return attachments.map((attachment, index) => {
    const selectedTokens = totalTokens <= MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS
      ? attachment.selectedTokens
      : index === attachments.length - 1
        ? remaining
        : Math.max(1, Math.floor((attachment.selectedTokens / totalTokens) * MAX_EVENT_EXTRACTION_ATTACHMENT_TOKENS));
    remaining -= selectedTokens;
    const text = attachment.text.slice(0, Math.max(1, Math.ceil(
      attachment.text.length * (selectedTokens / attachment.selectedTokens),
    )));
    console.info('attachment_conversion', {
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      tokens: attachment.tokens,
      selectedTokens,
      selectedCharacters: text.length,
      converter: attachment.converter,
    });
    return { ...attachment, text, selectedTokens };
  });
};

/**
 * Converts Source Message attachments to bounded text for event extraction.
 * Office normalization is retained only when Workers AI conversion is unavailable
 * or unusable; unconvertible files are errors, never silently omitted.
 */
export const convertAttachmentsForEventExtraction = async (
  attachments: AttachmentContent[],
  markdown?: MarkdownConverter,
): Promise<ConvertedAttachment[]> => boundConvertedAttachments(await Promise.all(attachments.map(async (attachment) => {
  try {
    if (!markdown) throw new Error('Workers AI Markdown conversion is unavailable.');
    return await convertedAttachment(attachment, markdown);
  } catch (error) {
    if (localOfficeMimeTypes.has(attachment.mimeType.toLowerCase())) {
      const fallback = localOfficeFallback(attachment);
      console.warn('attachment_conversion_fallback', {
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        reason: error instanceof Error ? error.message : 'conversion failed',
        tokens: fallback.tokens,
      });
      return fallback;
    }
    console.warn('attachment_conversion_failed', {
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      reason: error instanceof Error ? error.message : 'conversion failed',
    });
    throw error;
  }
})));

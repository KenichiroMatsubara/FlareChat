import { normalizeAttachments, type AttachmentContent } from './normalization';

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
  /** The complete conversion is admitted to the Gemini extraction request. */
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

const localOfficeFallback = (attachment: AttachmentContent): ConvertedAttachment => {
  const normalized = normalizeAttachments([attachment])[0];
  if (!normalized || normalized.kind !== 'text') throw new Error(`${attachment.filename} をローカルで正規化できませんでした。`);
  const tokens = Math.ceil(normalized.text.length / 4);
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text: normalized.text,
    tokens,
    selectedTokens: tokens,
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
  const text = result.data.trim();
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text,
    tokens: result.tokens,
    selectedTokens: result.tokens,
    converter: 'workers_ai',
  };
};

/**
 * Converts Source Message attachments to text for event extraction without
 * selecting, truncating, or otherwise changing the Markdown conversion.
 * Office normalization is retained only when Workers AI conversion is unavailable
 * or unusable; unconvertible files are errors, never silently omitted.
 */
export const convertAttachmentsForEventExtraction = async (
  attachments: AttachmentContent[],
  markdown?: MarkdownConverter,
): Promise<ConvertedAttachment[]> => Promise.all(attachments.map(async (attachment) => {
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
}));

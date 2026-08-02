import { cleanupConvertedMarkdown } from './markdown-cleanup';
import { normalizeAttachments, type AttachmentContent } from './normalization';
import { compactXlsxMarkdown } from './xlsx-markdown';

export interface MarkdownConversionResult {
  format: 'markdown' | 'text' | 'error';
  name: string;
  mimetype: string;
  tokens?: number;
  data?: string;
  error?: string;
}

export interface MarkdownConversionOptions {
  conversionOptions?: { pdf?: { metadata?: boolean } };
}

/** The narrow Workers AI seam needed by attachment conversion. */
export interface MarkdownConverter {
  toMarkdown(document: { name: string; blob: Blob }, options?: MarkdownConversionOptions): Promise<MarkdownConversionResult>;
}

/** Asks Workers AI not to emit the PDF metadata section this product never reads. */
const conversionRequestOptions: MarkdownConversionOptions = { conversionOptions: { pdf: { metadata: false } } };

export interface ConvertedAttachment {
  attachmentId: string;
  filename: string;
  originalMimeType: string;
  /** Workers AI's conversion estimate (or the local fallback estimate). */
  text: string;
  tokens: number;
  /** Estimated tokens of the conversion text admitted to the AI extraction request. */
  selectedTokens: number;
  converter: 'workers_ai' | 'local_office';
}

const localOfficeMimeTypes = new Set([
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const xlsxMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const isXlsx = (attachment: AttachmentContent): boolean =>
  attachment.mimeType.toLowerCase() === xlsxMimeType || attachment.filename.toLowerCase().endsWith('.xlsx');

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
  const text = cleanupConvertedMarkdown(normalized.text, attachment.filename);
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text,
    tokens: Math.ceil(normalized.text.length / 4),
    selectedTokens: Math.ceil(text.length / 4),
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
  }, conversionRequestOptions);
  if (result.format === 'error') throw new Error(result.error || `${attachment.filename} を変換できませんでした。`);
  if (!result.tokens || result.tokens < 1 || !result.data?.trim()) {
    throw new Error(`${attachment.filename} の変換結果が空です。`);
  }
  const sourceText = result.data.trim();
  const compacted = result.format === 'markdown' && isXlsx(attachment) ? compactXlsxMarkdown(sourceText) : sourceText;
  const text = cleanupConvertedMarkdown(compacted, attachment.filename);
  if (!text) throw new Error(`${attachment.filename} の圧縮後の変換結果が空です。`);
  return {
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    originalMimeType: attachment.mimeType,
    text,
    tokens: result.tokens,
    selectedTokens: Math.ceil(text.length / 4),
    converter: 'workers_ai',
  };
};

/**
 * Converts Source Message attachments to text for event extraction without
 * selecting or truncating it. XLSX Markdown is compacted mechanically to TSV
 * before admission, and every conversion has its by-products removed; the
 * document's own contents are always retained verbatim. Office normalization is
 * retained only when Workers AI conversion is unavailable or unusable;
 * unconvertible files are errors, never silently omitted.
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

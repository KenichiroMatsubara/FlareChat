import { convertAttachmentsForEventExtraction, type MarkdownConverter } from './attachment-conversion';
import type { AttachmentContent } from './normalization';

export interface EventDetails {
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  location: string;
  description: string;
}

export const GEMINI_EXTRACTION_MAX_SOURCE_CHARS = 20_000;
export const GEMINI_EXTRACTION_TIMEOUT_MS = 15_000;

export type GeminiAttachment = AttachmentContent;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

const geminiAttachmentParts = async (
  attachments: GeminiAttachment[],
  markdown?: MarkdownConverter,
): Promise<GeminiPart[]> =>
  (await convertAttachmentsForEventExtraction(attachments, markdown)).map((attachment) => {
    const filename = `Attachment filename: ${attachment.filename}`;
    return { text: `${filename}\nOriginal MIME type: ${attachment.originalMimeType}\n${attachment.text}` };
  });

/** Accepts only complete Gemini JSON that is safe to turn into a Scheduled Event. */
export const validatedEventDetails = (text: string): EventDetails | null => {
  try {
    const value = JSON.parse(text) as Partial<EventDetails>;
    if (!value.title?.trim() || !value.startsAt || !value.endsAt || !value.timeZone?.trim() || typeof value.location !== 'string' || typeof value.description !== 'string') return null;
    const startsAt = Date.parse(value.startsAt);
    const endsAt = Date.parse(value.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) return null;
    return {
      title: value.title.trim(),
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      timeZone: value.timeZone.trim(),
      location: value.location,
      description: value.description,
    };
  } catch {
    return null;
  }
};

/** Calls Gemini with bounded untrusted source text and accepts only validated Event Details JSON. */
export const extractGeminiEventDetails = async (input: {
  apiKey: string;
  model: string;
  source: string;
  attachments?: GeminiAttachment[];
  markdown?: MarkdownConverter;
  fetch?: typeof fetch;
}): Promise<EventDetails | null> => {
  const request = input.fetch ?? fetch;
  const source = input.source.slice(0, GEMINI_EXTRACTION_MAX_SOURCE_CHARS);
  const attachments = await geminiAttachmentParts(input.attachments ?? [], input.markdown);
  let response: Response;
  try {
    response = await request(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': input.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: `Extract exactly one event as JSON with title, startsAt, endsAt, timeZone, location, and description. Do not infer missing dates or times.\n\n${source}` },
              ...attachments,
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                startsAt: { type: 'STRING', format: 'date-time' },
                endsAt: { type: 'STRING', format: 'date-time' },
                timeZone: { type: 'STRING' },
                location: { type: 'STRING' },
                description: { type: 'STRING' },
              },
              required: ['title', 'startsAt', 'endsAt', 'timeZone', 'location', 'description'],
            },
          },
        }),
      },
    );
  } catch {
    throw new Error('Gemini API に接続できませんでした。');
  }

  let body: GeminiResponse;
  try {
    body = await response.json() as GeminiResponse;
  } catch {
    throw new Error('Gemini API から不正な応答が返されました。');
  }
  if (!response.ok) throw new Error(`Gemini API: ${body.error?.message?.trim() || `HTTP ${response.status}`}`);
  const text = body.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).map((part) => part.text ?? '').join('') ?? '';
  return validatedEventDetails(text);
};

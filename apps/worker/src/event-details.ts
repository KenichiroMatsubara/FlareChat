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

export interface GeminiAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  data: string;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

const GEMINI_UNSUPPORTED_INLINE_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const geminiAttachmentParts = (attachment: GeminiAttachment): GeminiPart[] => {
  const filename = `Attachment filename: ${attachment.filename}`;
  if (GEMINI_UNSUPPORTED_INLINE_MIME_TYPES.has(attachment.mimeType.toLowerCase())) {
    return [{ text: `${filename} (not sent to Gemini because this file type is unsupported)` }];
  }
  return [
    { text: filename },
    { inlineData: { mimeType: attachment.mimeType, data: attachment.data } },
  ];
};

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
  fetch?: typeof fetch;
}): Promise<EventDetails | null> => {
  const request = input.fetch ?? fetch;
  const source = input.source.slice(0, GEMINI_EXTRACTION_MAX_SOURCE_CHARS);
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
              ...(input.attachments?.flatMap(geminiAttachmentParts) ?? []),
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

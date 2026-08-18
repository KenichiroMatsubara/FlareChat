/** A published Source Attachment as it should appear inside a Google Calendar description. */
export interface AttachmentLink {
  filename: string;
  url: string;
}

export interface CalendarDescriptionInput {
  /** The Event Summary for this single Scheduled Event; omitted from the description when blank. */
  summary: string;
  /**
   * The Guest Registration counts by Affiliation, omitted when nobody from
   * outside has registered. It carries counts and never names, and it is passed
   * as plain text so the Affiliations another account wrote are escaped
   * here rather than by the caller that assembled them.
   */
  guestCounts?: string;
  attachments: AttachmentLink[];
  /** The trusted provenance sentence appended last. */
  attribution: string;
}

const escaped = (text: string): string => text
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const paragraph = (text: string): string => escaped(text.trim()).replaceAll('\n', '<br>');

/** Only an absolute http(s) URL may become a link; anything else stays inert escaped text. */
const linkableUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};

/** Renders one attachment as a labelled link, the Calendar equivalent of Markdown's [filename](url). */
export const attachmentLink = (attachment: AttachmentLink): string => {
  const url = linkableUrl(attachment.url);
  const label = escaped(attachment.filename.trim() || attachment.url.trim());
  return url ? `<a href="${escaped(url)}">${label}</a>` : label;
};

/**
 * Builds the Google Calendar description. Google Calendar renders a small HTML subset, so a
 * published Source Attachment shows its filename instead of a long unreadable Drive URL.
 */
export const calendarEventDescription = (input: CalendarDescriptionInput): string => {
  const blocks: string[] = [];
  if (input.summary.trim()) blocks.push(paragraph(input.summary));
  if (input.guestCounts?.trim()) blocks.push(paragraph(input.guestCounts));
  if (input.attachments.length) {
    blocks.push(['添付ファイル:', ...input.attachments.map(attachmentLink)].join('<br>'));
  }
  if (input.attribution.trim()) blocks.push(paragraph(input.attribution));
  return blocks.join('<br><br>');
};

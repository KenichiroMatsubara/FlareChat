export interface ContactLinkCheck {
  usedAt: string | null;
  expiresAt: string;
  now: string;
}

export const canConsumeContactLink = (link: ContactLinkCheck): boolean =>
  link.usedAt === null && Date.parse(link.now) < Date.parse(link.expiresAt);

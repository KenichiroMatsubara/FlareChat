export interface RecipientLinkCheck {
  usedAt: string | null;
  expiresAt: string;
  now: string;
}

export const canConsumeRecipientLink = (link: RecipientLinkCheck): boolean =>
  link.usedAt === null && Date.parse(link.now) < Date.parse(link.expiresAt);

export interface MemberLinkCheck {
  usedAt: string | null;
  expiresAt: string;
  now: string;
}

export const canConsumeMemberLink = (link: MemberLinkCheck): boolean =>
  link.usedAt === null && Date.parse(link.now) < Date.parse(link.expiresAt);

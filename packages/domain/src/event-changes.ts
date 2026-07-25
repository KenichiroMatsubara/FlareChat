export type EventChangeKind = 'create' | 'modify' | 'cancel';

export const classifyEventChange = (text: string): EventChangeKind => {
  if (/(?:中止|キャンセル|cancelled?)/iu.test(text)) return 'cancel';
  if (/(?:変更|更新|modify|change)/iu.test(text)) return 'modify';
  return 'create';
};

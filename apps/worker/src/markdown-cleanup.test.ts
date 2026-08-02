import { describe, expect, it } from 'vitest';

import { cleanupConvertedMarkdown } from './markdown-cleanup';

/** Mirrors the shape Workers AI emits for a PDF invitation, with invented identifiers. */
const convertedInvitation = [
  '# 記念式典登録のご案内.pdf',
  '## Metadata',
  '- PDFFormatVersion=1.7',
  '- Language=ja',
  '- IsLinearized=false',
  '- IsAcroFormPresent=false',
  '- IsXFAPresent=false',
  '- IsCollectionPresent=false',
  '- IsSignaturesPresent=false',
  '- Author=example author',
  '- Creator=Microsoft® Word for Microsoft 365',
  "- CreationDate=D:20260406221551+09'00'",
  "- ModDate=D:20260406221551+09'00'",
  '- Producer=Microsoft® Word for Microsoft 365',
  '- pdf:producer=Microsoft® Word for Microsoft 365',
  '- dc:creator=example author',
  '- xmp:creatortool=Microsoft® Word for Microsoft 365',
  '- xmp:createdate=2026-04-06T22:15:51+09:00',
  '- xmp:modifydate=2026-04-06T22:15:51+09:00',
  '- xmpmm:documentid=uuid:00000000-0000-4000-8000-000000000001',
  '- xmpmm:instanceid=uuid:00000000-0000-4000-8000-000000000001',
  '',
  '',
  '## Contents',
  '### Page 1',
  '',
  '2026 年４月吉日',
  '',
  '',
  '記',
  '',
  '',
  '日 時',
  '',
  '',
  '2026年5月30日（土）',
  '',
  '',
  '※5 月15 日(金)までに振込いただきますようお願いいたします。',
  '',
  '',
  '### Page 2',
  '',
  '祝 宴',
  '',
  '',
  '17：30 開宴',
].join('\n');

describe('converted attachment cleanup', () => {
  it('removes conversion by-products and keeps every line of the document itself', () => {
    expect(cleanupConvertedMarkdown(convertedInvitation, '記念式典登録のご案内.pdf')).toBe([
      '### Page 1',
      '',
      '2026 年４月吉日',
      '',
      '記',
      '',
      '日 時',
      '',
      '2026年5月30日（土）',
      '',
      '※5 月15 日(金)までに振込いただきますようお願いいたします。',
      '',
      '### Page 2',
      '',
      '祝 宴',
      '',
      '17：30 開宴',
    ].join('\n'));
  });

  it('keeps a metadata heading that belongs to the document rather than the converter', () => {
    const report = [
      '# 仕様書.pdf',
      '### Page 1',
      '',
      '## Metadata',
      '- 収集した項目は次のとおりです。',
      '- 氏名と所属を記録します。',
    ].join('\n');

    expect(cleanupConvertedMarkdown(report, '仕様書.pdf')).toBe([
      '### Page 1',
      '',
      '## Metadata',
      '- 収集した項目は次のとおりです。',
      '- 氏名と所属を記録します。',
    ].join('\n'));
  });

  it('keeps a heading that is not the converter echo of this attachment filename', () => {
    expect(cleanupConvertedMarkdown('# 総会資料\n\n議題を確認してください。', '案内.pdf'))
      .toBe('# 総会資料\n\n議題を確認してください。');
  });

  it('preserves blank lines inside a fenced block', () => {
    const fenced = ['説明', '', '', '```', 'a', '', '', 'b', '```', '', '', '続き'].join('\n');

    expect(cleanupConvertedMarkdown(fenced, '手順.pdf'))
      .toBe(['説明', '', '```', 'a', '', '', 'b', '```', '', '続き'].join('\n'));
  });

  it('leaves text that carries none of the converter by-products unchanged', () => {
    const plain = '日時: 2026年5月30日 13:00-16:00\n会場: 会館';

    expect(cleanupConvertedMarkdown(plain, '案内.pdf')).toBe(plain);
  });
});

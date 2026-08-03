import { describe, expect, it } from 'vitest';

import { attachmentLink, calendarEventDescription } from './event-description';

describe('Google Calendar description', () => {
  it('links a published Source Attachment by filename instead of its raw URL', () => {
    const description = calendarEventDescription({
      summary: '地区大会の登録受付です。参加費は3,000円です。',
      attachments: [
        { filename: '③RAC用登録シート.xlsx', url: 'https://docs.google.com/spreadsheets/d/1cMA9FAkO91jpi/edit?usp=drivesdk&rtpof=true' },
        { filename: '②26-27地区大会.pdf', url: 'https://drive.google.com/file/d/1Ee2OszLAVoOgqx/view?usp=drivesdk' },
      ],
      attribution: 'Mail Automation が Gmail メッセージ 19fc6ffaec9d2256 から作成しました。',
    });

    expect(description).toBe([
      '地区大会の登録受付です。参加費は3,000円です。',
      '<br><br>添付ファイル:',
      '<br><a href="https://docs.google.com/spreadsheets/d/1cMA9FAkO91jpi/edit?usp=drivesdk&amp;rtpof=true">③RAC用登録シート.xlsx</a>',
      '<br><a href="https://drive.google.com/file/d/1Ee2OszLAVoOgqx/view?usp=drivesdk">②26-27地区大会.pdf</a>',
      '<br><br>Mail Automation が Gmail メッセージ 19fc6ffaec9d2256 から作成しました。',
    ].join(''));
  });

  it('keeps the attribution alone when the Event Summary and the attachments are empty', () => {
    expect(calendarEventDescription({
      summary: '   ',
      attachments: [],
      attribution: 'Mail Automation が Gmail メッセージ gmail-1 から作成しました。',
    })).toBe('Mail Automation が Gmail メッセージ gmail-1 から作成しました。');
  });

  it('escapes untrusted summary text and keeps its line breaks readable', () => {
    expect(calendarEventDescription({
      summary: '受付は<会館>前\n持ち物は "名札" と資料 & 筆記具',
      attachments: [],
      attribution: '',
    })).toBe('受付は&lt;会館&gt;前<br>持ち物は &quot;名札&quot; と資料 &amp; 筆記具');
  });

  it('escapes a filename that carries markup', () => {
    expect(attachmentLink({ filename: '<b>案内</b>.pdf', url: 'https://drive.example/file' }))
      .toBe('<a href="https://drive.example/file">&lt;b&gt;案内&lt;/b&gt;.pdf</a>');
  });

  it('refuses to link a URL that is not http or https', () => {
    expect(attachmentLink({ filename: '案内.pdf', url: 'javascript:alert(1)' })).toBe('案内.pdf');
    expect(attachmentLink({ filename: '', url: 'not a url' })).toBe('not a url');
  });
});

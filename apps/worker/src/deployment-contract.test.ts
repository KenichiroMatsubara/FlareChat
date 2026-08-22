import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DUE_WORK_CRON, MAIL_POLL_CRON } from './background/runner';

const packageJson = (path: string): { scripts: Record<string, string> } => JSON.parse(
  readFileSync(resolve(import.meta.dirname, path), 'utf8'),
) as { scripts: Record<string, string> };

describe('deployment contract', () => {
  it('declares exactly the cron cadences the background runner reads', () => {
    const wrangler = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'),
    ) as { triggers: { crons: string[] } };

    expect(wrangler.triggers.crons).toEqual([DUE_WORK_CRON, MAIL_POLL_CRON]);
  });

  it('routes both root and Worker deploy commands through the migration release pipeline', () => {
    const root = packageJson('../../../package.json');
    const worker = packageJson('../package.json');

    expect(worker.scripts.deploy).not.toContain('wrangler deploy');
    expect(worker.scripts.deploy).toContain('npm run deploy --prefix ../..');
    expect(root.scripts['deploy:cloudflare']).toContain('db:migrate:control:remote');
    expect(root.scripts['deploy:cloudflare']).toContain('db:migrate:organization:remote');
    expect(root.scripts['deploy:cloudflare']).toContain('deploy:worker:release');
    expect(root.scripts['deploy:cloudflare']).toContain('db:migrate:complete:remote');
    expect(worker.scripts['deploy:worker:release']).toContain('wrangler deploy');
  });
});

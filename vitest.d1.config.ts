import { readFile } from 'node:fs/promises';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  plugins: [{
    name: 'sql-text-modules',
    enforce: 'pre',
    load: async (id) => id.endsWith('.sql')
      ? `export default ${JSON.stringify(await readFile(id, 'utf8'))};`
      : null,
  }],
  test: {
    include: ['apps/worker/src/**/*.d1.test.ts'],
    setupFiles: ['./test/clock.ts'],
    pool: '@cloudflare/vitest-pool-workers',
    poolOptions: {
      workers: {
        isolatedStorage: true,
        miniflare: {
          compatibilityDate: '2026-03-10',
          d1Databases: {
            CONTROL_DB: 'control-test',
            LOCAL_ORGANIZATION_DB_1: 'organization-test',
          },
        },
      },
    },
  },
});

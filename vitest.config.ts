import { readFile } from 'node:fs/promises';
import { configDefaults, defineConfig } from 'vitest/config';

/** The GUI's tests drive screens in a DOM; everything else runs in Node. */
const webTests = 'apps/web/**/*.test.{ts,tsx}';

export default defineConfig({
  plugins: [{
    name: 'sql-text-modules',
    enforce: 'pre',
    load: async (id) => id.endsWith('.sql')
      ? `export default ${JSON.stringify(await readFile(id, 'utf8'))};`
      : null,
  }],
  test: {
    exclude: [...configDefaults.exclude, '**/*.d1.test.ts'],
    setupFiles: ['./test/clock.ts'],
    projects: [
      { extends: true, test: { name: 'web', environment: 'jsdom', include: [webTests] } },
      { extends: true, test: { name: 'node', exclude: [...configDefaults.exclude, '**/*.d1.test.ts', webTests] } },
    ],
  },
});

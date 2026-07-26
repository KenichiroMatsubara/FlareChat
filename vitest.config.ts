import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{
    name: 'sql-text-modules',
    enforce: 'pre',
    load: async (id) => id.endsWith('.sql')
      ? `export default ${JSON.stringify(await readFile(id, 'utf8'))};`
      : null,
  }],
});

import { readFile } from 'node:fs/promises';

export const load = async (url, context, nextLoad) => {
  if (!url.endsWith('.sql')) return nextLoad(url, context);
  const sql = await readFile(new URL(url), 'utf8');
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(sql)};`,
  };
};

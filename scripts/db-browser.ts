import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { findControlDatabase } from './find-local-d1.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DB_BROWSER_PORT ?? 4984);

interface Statement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
}

interface Database {
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as DatabaseConstructor;
const databasePath = findControlDatabase();

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const serializeValue = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
};

const readTables = (database: Database): string[] => database
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name")
  .all()
  .flatMap((row) => isRecord(row) && typeof row.name === 'string' && row.name !== 'd1_migrations' ? [row.name] : []);

const readTable = (name: string): { columns: string[]; rows: Array<Record<string, unknown>> } => {
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    const tables = readTables(database);
    if (!tables.includes(name)) throw new Error(`Unknown table: ${name}`);
    const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(name)} LIMIT 200`).all();
    const records = rows.flatMap((row) => {
      if (!isRecord(row)) return [];
      return [Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeValue(value)]))];
    });
    return { columns: records.length > 0 ? Object.keys(records[0] ?? {}) : [], rows: records };
  } finally {
    database.close();
  }
};

const readTableSummary = (): Array<{ name: string; count: number }> => {
  const database = new BetterSqlite3(databasePath, { readonly: true });
  try {
    return readTables(database).map((name) => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get();
      const count = isRecord(row) && typeof row.count === 'number' ? row.count : 0;
      return { name, count };
    });
  } finally {
    database.close();
  }
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(json);
};

const sendPage = (response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
};

const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
    if (url.pathname === '/') return sendPage(response);
    if (url.pathname === '/api/tables') return sendJson(response, 200, readTableSummary());
    if (url.pathname === '/api/table') {
      const name = url.searchParams.get('name');
      if (!name) return sendJson(response, 400, { error: 'Table name is required.' });
      return sendJson(response, 200, readTable(name));
    }
    return sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database browser request failed.';
    return sendJson(response, 500, { error: message });
  }
};

const openBrowser = (url: string): void => {
  if (process.env.DB_BROWSER_NO_OPEN === '1') return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
};

const server = createServer(handleRequest);
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Local DB browser is running at ${url}`);
  console.log(`Database: ${databasePath}`);
  openBrowser(url);
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local D1 Browser</title>
<style>
:root { color-scheme: dark; font: 14px system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; display: grid; grid-template-columns: 260px 1fr; height: 100vh; background: #111; color: #eee; }
aside { border-right: 1px solid #333; overflow: auto; padding: 16px; }
main { min-width: 0; overflow: auto; padding: 24px; }
h1 { font-size: 20px; margin: 0 0 16px; }
button { display: block; width: 100%; border: 0; border-radius: 6px; background: transparent; color: #ccc; cursor: pointer; padding: 9px 10px; text-align: left; }
button:hover, button.active { background: #292929; color: #fff; }
.count { color: #888; float: right; }
.meta { color: #888; margin-bottom: 16px; }
.table-wrap { overflow: auto; border: 1px solid #333; border-radius: 8px; }
table { border-collapse: collapse; min-width: 100%; white-space: nowrap; }
th, td { border-bottom: 1px solid #292929; padding: 9px 12px; text-align: left; vertical-align: top; }
th { position: sticky; top: 0; background: #1d1d1d; }
td.null { color: #777; font-style: italic; }
.empty { color: #888; }
</style>
</head>
<body>
<aside><h1>Local D1</h1><div id="tables">Loading…</div></aside>
<main><h1 id="title">Select a table</h1><div class="meta" id="meta"></div><div id="content" class="empty">Loading…</div></main>
<script>
const tables = document.getElementById('tables');
const title = document.getElementById('title');
const meta = document.getElementById('meta');
const content = document.getElementById('content');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const renderTable = async (name) => {
  document.querySelectorAll('button[data-table]').forEach((button) => button.classList.toggle('active', button.dataset.table === name));
  title.textContent = name;
  meta.textContent = 'Loading…';
  content.textContent = '';
  const response = await fetch('/api/table?name=' + encodeURIComponent(name));
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to load table.');
  meta.textContent = data.rows.length + ' rows (up to 200 shown)';
  if (data.rows.length === 0) { content.textContent = 'No rows'; content.className = 'empty'; return; }
  content.className = 'table-wrap';
  content.innerHTML = '<table><thead><tr>' + data.columns.map((column) => '<th>' + escapeHtml(column) + '</th>').join('') + '</tr></thead><tbody>' + data.rows.map((row) => '<tr>' + data.columns.map((column) => { const value = row[column]; return '<td class="' + (value === null ? 'null' : '') + '">' + escapeHtml(value === null ? 'NULL' : value) + '</td>'; }).join('') + '</tr>').join('') + '</tbody></table>';
};
const loadTables = async () => {
  const response = await fetch('/api/tables');
  const data = await response.json();
  tables.innerHTML = data.map((table) => '<button data-table="' + escapeHtml(table.name) + '">' + escapeHtml(table.name) + '<span class="count">' + table.count + '</span></button>').join('');
  tables.querySelectorAll('button[data-table]').forEach((button) => button.addEventListener('click', () => renderTable(button.dataset.table).catch((error) => { content.textContent = error.message; })));
  if (data[0]) await renderTable(data[0].name);
};
loadTables().catch((error) => { content.textContent = error.message; });
</script>
</body>
</html>`;

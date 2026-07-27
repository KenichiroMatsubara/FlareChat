const separatorCell = /^:?-{2,}:?$/u;
const emptyHeader = /^(?:__EMPTY(?:_\d+)?|Unnamed:?\s*\d*|Column\d+)?$/iu;

const splitCells = (line: string): string[] => {
  let source = line.trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|')) source = source.slice(0, -1);
  return source.split(/(?<!\\)\|/u).map((cell) => cell.trim());
};

const compactTable = (block: string): string => {
  let rows = block.split('\n').filter((line) => line.trim()).map(splitCells);
  rows = rows.filter((row) => !row.every((cell) => separatorCell.test(cell)));
  if (!rows.length) return '';

  const columnCount = Math.max(...rows.map((row) => row.length));
  rows = rows.map((row) => row.concat(Array<string>(columnCount - row.length).fill('')));

  const [header, ...body] = rows;
  if (!header) return '';
  const hasHeader = !header.every((cell) => emptyHeader.test(cell));
  const keptColumns: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const isNamed = hasHeader && !emptyHeader.test(header[column] ?? '');
    if (isNamed || body.some((row) => (row[column] ?? '') !== '')) keptColumns.push(column);
  }
  if (!keptColumns.length) return '';

  const output: string[][] = [];
  if (hasHeader) output.push(keptColumns.map((column) => header[column] ?? ''));
  for (const row of body) {
    const values = keptColumns.map((column) => row[column] ?? '');
    if (values.every((cell) => cell === '')) continue;
    while (values.at(-1) === '') values.pop();
    output.push(values);
  }
  return output.map((row) => row.join('\t')).join('\n') + '\n';
};

/**
 * Shrinks SheetJS-style Markdown tables emitted for XLSX files without reading
 * their contents semantically: layout padding, synthetic headers, and blank
 * rectangle cells become TSV's much smaller representation.
 */
export const compactXlsxMarkdown = (markdown: string): string =>
  markdown.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$)){2,}/gmu, compactTable);

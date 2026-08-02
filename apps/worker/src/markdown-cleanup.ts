const metadataEntry = /^-\s[A-Za-z][A-Za-z0-9_.:-]*=/u;

const fenceDelimiter = /^\s*(?:```|~~~)/u;

/** Drops the converter's echo of the filename, which the AI request already states itself. */
const withoutTitleHeading = (markdown: string, filename: string): string => {
  const heading = `# ${filename}`;
  if (markdown === heading) return '';
  if (!markdown.startsWith(`${heading}\n`)) return markdown;
  return markdown.slice(heading.length).replace(/^\n+/u, '');
};

/**
 * Drops a leading PDF metadata section. The section is removed only when it
 * opens the conversion and every one of its lines is a `- key=value` entry, so
 * a document whose own contents use the same heading is never touched.
 */
const withoutMetadataSection = (markdown: string): string => {
  const section = /^## Metadata\n((?:-[^\n]*(?:\n|$))+)/u.exec(markdown);
  if (!section?.[1]) return markdown;
  const entries = section[1].split('\n').filter((line) => line.trim());
  if (!entries.every((line) => metadataEntry.test(line))) return markdown;
  return markdown.slice(section[0].length).replace(/^\n+/u, '');
};

/** Drops the heading that separated metadata from contents once metadata is gone. */
const withoutContentsHeading = (markdown: string): string =>
  markdown.replace(/^## Contents\n/u, '');

/** Collapses runs of blank lines outside fenced blocks, where they carry no meaning. */
const collapsedBlankLines = (markdown: string): string => {
  const output: string[] = [];
  let fenced = false;
  let blankRun = 0;
  for (const line of markdown.split('\n')) {
    if (fenceDelimiter.test(line)) {
      fenced = !fenced;
      blankRun = 0;
      output.push(line);
      continue;
    }
    if (!fenced && !line.trim()) {
      blankRun += 1;
      if (blankRun > 1) continue;
      output.push(line);
      continue;
    }
    blankRun = 0;
    output.push(line);
  }
  return output.join('\n');
};

/**
 * Removes conversion by-products from converted attachment text without reading
 * or selecting its contents: the filename echo, the PDF metadata section, the
 * contents heading, and blank-line padding. It only ever deletes; it never
 * reorders, rewrites, truncates, or adds text.
 */
export const cleanupConvertedMarkdown = (markdown: string, filename: string): string =>
  collapsedBlankLines(
    withoutContentsHeading(withoutMetadataSection(withoutTitleHeading(markdown.trim(), filename))),
  ).trim();

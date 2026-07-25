export interface RecipientImportPreview {
  accepted: Array<{ name: string; email: string }>;
  duplicates: string[];
  invalid: Array<{ row: number; value: string }>;
}

/** Parses a small name,email CSV preview without persisting recipient data. */
export const previewRecipientCsv = (csv: string): RecipientImportPreview => {
  const accepted: Array<{ name: string; email: string }> = [];
  const duplicates: string[] = [];
  const invalid: Array<{ row: number; value: string }> = [];
  const seen = new Set<string>();
  for (const [index, line] of csv.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const [rawName, rawEmail, ...rest] = line.split(',').map((value) => value.trim());
    const email = rawEmail?.toLowerCase() ?? '';
    if (!rawName || !email || rest.length > 0 || !email.includes('@')) { invalid.push({ row: index + 1, value: line }); continue; }
    if (seen.has(email)) { duplicates.push(email); continue; }
    seen.add(email);
    accepted.push({ name: rawName, email });
  }
  return { accepted, duplicates, invalid };
};

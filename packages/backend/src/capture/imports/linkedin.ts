import type { ImportedPost } from "./x.js";

/**
 * Parser for the LinkedIn data export's Shares.csv:
 * Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility
 * Fields may be quoted and contain newlines.
 */
export function parseLinkedInShares(csv: string): ImportedPost[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const linkIdx = header.indexOf("sharelink");
  const textIdx = header.indexOf("sharecommentary");
  if (textIdx === -1) throw new Error("Not a LinkedIn Shares.csv - missing ShareCommentary column");

  const posts: ImportedPost[] = [];
  for (const row of rows.slice(1)) {
    const text = (row[textIdx] ?? "").trim();
    if (!text) continue;
    const date = dateIdx >= 0 ? new Date(row[dateIdx] ?? "") : new Date();
    posts.push({
      text,
      postedAt: Number.isNaN(date.getTime()) ? new Date() : date,
      url: linkIdx >= 0 && row[linkIdx] ? row[linkIdx] : undefined,
    });
  }
  return posts;
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded newlines/commas, "" escapes). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

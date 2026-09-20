import { marked } from "marked";

export interface Attachment {
  filename: string;
  mimeType: string;
  /** UTF-8 text content of the attachment. */
  content: string;
}

function escapeCsvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize an array of objects (or arrays) into a CSV string. Uses the keys of
 * the first non-empty object as the header. Cell values may be nested (objects
 * / arrays) — they are collapsed to a readable scalar.
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]);
  const lines = [header.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(
      header
        .map((k) => escapeCsvField(csvScalar(row[k])))
        .join(","),
    );
  }
  return lines.join("\n");
}

function csvScalar(value: unknown): unknown {
  if (value == null) return "";
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(csvScalar).join(" | ");
    return JSON.stringify(value);
  }
  return value;
}

// ─── Report attachment helpers ──────────────────────────────────────────────

const REPORT_WORDS = [
  "rapport",
  "report",
  "résumé en fichier",
  "fichiers joint",
  "pièce jointe",
  "document",
];

const DATASET_WORDS = [
  "csv",
  "dataset",
  "donnée brute",
  "donnees brutes",
  "export",
  "tableur",
  "spreadsheet",
  "xlsx",
];

/**
 * Whether the user explicitly asks for a report document (.md + .html) to be
 * attached.
 */
export function wantsReport(text: string): boolean {
  const lower = text.toLowerCase();
  return REPORT_WORDS.some((w) => lower.includes(w));
}

/**
 * Whether the user explicitly asks for a raw dataset (e.g. CSV of a query) to
 * be attached.
 */
export function wantsDataset(text: string): boolean {
  const lower = text.toLowerCase();
  return DATASET_WORDS.some((w) => lower.includes(w));
}

/** Whether the user asked for any file attachment (report and/or dataset). */
export function wantsAttachment(text: string): boolean {
  return wantsReport(text) || wantsDataset(text);
}

/**
 * Structural heuristic for "this answer is a report worth exporting": long
 * enough and structured with headings (or a table).
 */
const REPORT_MIN_CHARS = 600;
const REPORT_MIN_HEADINGS = 2;

export function isReportLike(markdown: string): boolean {
  const text = markdown.trim();
  if (text.length < REPORT_MIN_CHARS) return false;
  const headings = (markdown.match(/^#{1,6}\s/gm) ?? []).length;
  if (headings >= REPORT_MIN_HEADINGS) return true;
  // Tables are also a strong report signal.
  return /^\s*\|.+\|.+\|\s*$/m.test(markdown);
}

/** Build the .md and .html attachments for a report body. */
export function buildReportAttachments(
  markdown: string,
  title = "Rapport",
): Attachment[] {
  return [
    { filename: "rapport.md", mimeType: "text/markdown", content: markdown },
    {
      filename: "rapport.html",
      mimeType: "text/html",
      content: renderHtml(markdown, title),
    },
  ];
}

function renderHtml(markdown: string, title: string): string {
  const body = marked.parse(markdown) as string;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         line-height: 1.6; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  h1, h2, h3 { line-height: 1.25; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #888; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: rgba(0,0,0,0.06); }
  code { background: rgba(0,0,0,0.06); padding: 0.1rem 0.3rem; border-radius: 4px; }
  pre { background: rgba(0,0,0,0.06); padding: 1rem; border-radius: 6px; overflow-x: auto; }
  blockquote { border-left: 4px solid #888; margin-left: 0; padding-left: 1rem; color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c];
  });
}


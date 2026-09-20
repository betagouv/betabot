import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toCsv,
  isReportLike,
  buildReportAttachments,
} from "../attachments.js";

describe("toCsv", () => {
  it("produces a header and rows with RFC4180 escaping", () => {
    const csv = toCsv([
      { name: "Julie", note: "a,b" },
      { name: 'Bob "Le" Boss', note: 'say "hi"' },
    ]);
    assert.equal(
      csv,
      [
        "name,note",
        'Julie,"a,b"',
        '"Bob ""Le"" Boss","say ""hi"""',
      ].join("\n"),
    );
  });

  it("returns an empty string for no rows", () => {
    assert.equal(toCsv([]), "");
  });

  it("collapses nested arrays/objects to a readable scalar", () => {
    const csv = toCsv([{ tags: ["a", "b"], meta: { x: 1 } }]);
    assert.equal(csv, 'tags,meta\na | b,"{""x"":1}"');
  });
});

describe("isReportLike", () => {
  it("returns false for short answers", () => {
    assert.equal(isReportLike("Réponse courte."), false);
  });

  it("returns true for a long structured answer with headings", () => {
    const md = [
      "# Rapport",
      "",
      "## Section 1",
      "",
      "contenu ".repeat(100),
      "",
      "## Section 2",
      "",
      "autre contenu ".repeat(100),
    ].join("\n");
    assert.equal(isReportLike(md), true);
  });

  it("returns true for a long table without headings", () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) => `| startup ${i} | ${i}% |`,
    ).join("\n");
    const md = rows + "\ncontenu ".repeat(80);
    assert.equal(isReportLike(md), true);
  });

  it("returns false for a long paragraph without structure", () => {
    assert.equal(isReportLike("texte ".repeat(200)), false);
  });
});

describe("buildReportAttachments", () => {
  it("produces markdown and html attachments", () => {
    const [md, html] = buildReportAttachments("# Titre\n\nBonjour", "Titre");
    assert.equal(md.filename, "rapport.md");
    assert.equal(md.mimeType, "text/markdown");
    assert.equal(md.content, "# Titre\n\nBonjour");
    assert.equal(html.filename, "rapport.html");
    assert.equal(html.mimeType, "text/html");
    assert.match(html.content, /<h1>Titre<\/h1>/);
    assert.match(html.content, /<p>Bonjour<\/p>/);
    assert.match(html.content, /<title>Titre<\/title>/);
  });
});

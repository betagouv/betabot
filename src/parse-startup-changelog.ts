import fs from "fs";
import { JSDOM } from "jsdom";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("Usage: parse-startup-changelog.ts <input.html> <output.json>");
  process.exit(1);
}

const html = fs.readFileSync(inputPath, "utf-8");
const { window } = new JSDOM(html);
const { document } = window;

interface StartupChangelog {
  diff: string;
  lastModified: string | null;
}

const changelogs: Record<string, StartupChangelog> = {};

for (const h3 of document.querySelectorAll("h3")) {
  const link = h3.querySelector<HTMLAnchorElement>(
    'a[href*="beta.gouv.fr/startups/"]',
  );
  if (!link) continue;

  const href = link.getAttribute("href") ?? "";
  const slug = href.split("/startups/")[1];
  if (!slug) continue;

  // Walk siblings to find "Dernière modification:" paragraph and the diff block
  let lastModified: string | null = null;
  let sibling = h3.nextElementSibling;
  while (sibling && !sibling.classList.contains("language-diff")) {
    if (
      sibling.tagName === "P" &&
      sibling.querySelector("strong")?.textContent?.startsWith("Dernière modification")
    ) {
      const raw = (sibling.textContent ?? "")
        .replace(/Dernière modification\s*:?\s*/i, "")
        .trim();
      if (raw) lastModified = raw;
    }
    sibling = sibling.nextElementSibling;
  }
  if (!sibling) continue;

  const diffDiv = sibling.querySelector<HTMLElement>("div[data-code]");
  if (!diffDiv) continue;

  const diff = diffDiv.getAttribute("data-code") ?? "";
  if (diff) changelogs[slug] = { diff, lastModified };
}

fs.writeFileSync(outputPath, JSON.stringify({ changelogs }, null, 2));
const withDate = Object.values(changelogs).filter((c) => c.lastModified).length;
console.log(
  `Wrote ${Object.keys(changelogs).length} startup changelogs to ${outputPath} (${withDate} with lastModified date)`,
);

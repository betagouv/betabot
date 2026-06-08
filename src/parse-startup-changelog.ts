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

const result: Record<string, string> = {};

for (const h3 of document.querySelectorAll("h3")) {
  const link = h3.querySelector<HTMLAnchorElement>(
    'a[href*="beta.gouv.fr/startups/"]',
  );
  if (!link) continue;

  const href = link.getAttribute("href") ?? "";
  const slug = href.split("/startups/")[1];
  if (!slug) continue;

  // Find the next <pre class="language-diff"> sibling
  let sibling = h3.nextElementSibling;
  while (sibling && !sibling.classList.contains("language-diff")) {
    sibling = sibling.nextElementSibling;
  }
  if (!sibling) continue;

  const diffDiv = sibling.querySelector<HTMLElement>("div[data-code]");
  if (!diffDiv) continue;

  const diff = diffDiv.getAttribute("data-code") ?? "";
  if (diff) result[slug] = diff;
}

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(`Wrote ${Object.keys(result).length} startup changelogs to ${outputPath}`);

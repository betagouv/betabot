/**
 * Generic documentation crawler.
 * Usage: npx tsx fetch-docs.ts <start-url> <output-dir>
 *
 * Crawls all pages reachable from <start-url> that share the same URL path
 * prefix, extracts main article content via Readability, converts to markdown
 * with Turndown, and writes one .md file per page to <output-dir>.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { CheerioCrawler, Configuration } from "crawlee";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const startUrl = process.argv[2];
const outputDir = process.argv[3];

if (!startUrl || !outputDir) {
  console.error("Usage: npx tsx fetch-docs.ts <start-url> <output-dir>");
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const base = new URL(startUrl);
const pathPrefix = base.pathname.replace(/\/$/, "");
// Match the start URL itself and anything under it
const glob = `${base.origin}${pathPrefix}{,/**}`;

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const saved = new Set<string>();

const storageDir = path.join(os.tmpdir(), "crawlee-fetch-docs");
// Always start fresh so stale queue state doesn't skip pages
fs.rmSync(storageDir, { recursive: true, force: true });

const config = new Configuration({
  storageClientOptions: { localDataDirectory: storageDir },
  // Avoid spawning `ps` (missing in slim containers) for memory probing
  memoryMbytes: 512,
});

const crawler = new CheerioCrawler({
  maxRequestsPerCrawl: 100,

  async requestHandler({ request, $, enqueueLinks }) {
    await enqueueLinks({
      globs: [glob],
      transformRequestFunction(req) {
        req.url = req.url.split("?")[0].split("#")[0];
        return req;
      },
    });

    const dom = new JSDOM($.html(), { url: request.url });
    const article = new Readability(dom.window.document).parse();

    // Fall back to raw body text if Readability finds nothing substantial
    const rawContent = article?.content ?? $("main, article, [role=main]").html() ?? $.html();
    if (!rawContent || rawContent.trim().length < 100) {
      return;
    }
    const articleTitle = article?.title ?? $("title").text() ?? request.url;

    const markdown = td.turndown(rawContent);
    if (markdown.trim().length < 50) return;

    const slug =
      new URL(request.url).pathname
        .replace(/^\//, "")
        .replace(/\//g, "-")
        .replace(/[^a-z0-9-]/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "index";

    if (saved.has(slug)) return;
    saved.add(slug);

    fs.writeFileSync(
      path.join(outputDir, `${slug}.md`),
      `# ${articleTitle}\n\n${markdown}`,
    );
    console.log(`  ✓ ${slug}.md`);
  },
}, config);

console.log(`Crawling ${startUrl} → ${outputDir}`);
await crawler.run([startUrl]);
console.log(`\nDone — ${saved.size} pages saved`);

import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";

const RSS_ENTITIES = (process.env["CHOISIRLESERVICEPUBLIC_IDS"] ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

interface JobItem {
  title: string;
  link: string;
  description: string;
  categories: string[];
  pubDate: string;
  organisme: string;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

// Channel title looks like:
// "Export RSS des offres - Seulement les offres à la une : Non / Organisme de rattachement : Ministère de la Culture"
// The organisme, when present, is the trailing part after "Organisme de rattachement :".
function extractOrganisme(channelTitle: string): string {
  const match = channelTitle.match(/Organisme de rattachement\s*:\s*(.+)$/i);
  return match ? match[1].trim() : "";
}

function parseRss(xml: string): JobItem[] {
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  const channelTitle = textOf(dom.window.document.querySelector("channel > title"));
  const organisme = extractOrganisme(channelTitle);
  const items = Array.from(dom.window.document.querySelectorAll("item"));
  return items.map((item) => ({
    title: textOf(item.querySelector("title")),
    link: textOf(item.querySelector("link")),
    description: textOf(item.querySelector("description")),
    categories: Array.from(item.querySelectorAll("category")).map((c) =>
      textOf(c),
    ),
    pubDate: textOf(item.querySelector("pubDate")),
    organisme,
  }));
}

async function fetchEntity(rssEntity: string): Promise<JobItem[]> {
  const url = `https://place-ep-recrute.talent-soft.com/handlers/offerRss.ashx?LCID=1036&Rss_Entity=${encodeURIComponent(rssEntity)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Choisir le service public RSS error ${res.status} for Rss_Entity="${rssEntity}": ${await res.text()}`,
    );
  }
  const xml = await res.text();
  return parseRss(xml);
}

async function main() {
  if (RSS_ENTITIES.length === 0) {
    console.log(
      "CHOISIRLESERVICEPUBLIC_IDS is not set, skipping choisirleservicepublic fetch",
    );
    return;
  }

  const outDir = path.join(DATA_DIR, "choisirleservicepublic");
  fs.mkdirSync(outDir, { recursive: true });

  for (const rssEntity of RSS_ENTITIES) {
    console.log(`Fetching jobs for Rss_Entity: ${rssEntity}`);
    const jobs = await fetchEntity(rssEntity);
    console.log(`  ${jobs.length} jobs found`);
    fs.writeFileSync(
      path.join(outDir, `${rssEntity}.json`),
      JSON.stringify(jobs, null, 2),
    );
  }

  console.log(`  Written to ${outDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

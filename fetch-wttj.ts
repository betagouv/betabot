import fs from "fs";
import path from "path";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";

const TOKEN = process.env["WELCOMEKIT_TOKEN"] ?? "";

const orgs = [{ id: "ci7AvS", slug: "communaute-beta-gouv" }];

interface WttjJob {
  reference: string;
  name: string;
  description?: string;
  profile?: string;
  contract_type?: string;
  remote?: string;
  apply_url?: string;
  office?: { name?: string; city?: string; country_code?: string };
  published_at?: string;
}

interface WttjResponse extends Array<WttjJob> {}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJobs(org: string): Promise<WttjJob[]> {
  const all: WttjJob[] = [];
  let page = 1;
  const url = `https://www.welcomekit.co/api/v1/external/jobs?status=published&organization_reference=${encodeURIComponent(org)}&page=${page}&per_page=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(
      `WelcomeKit API error ${res.status} for org "${org}": ${await res.text()}`,
    );
  }
  const data = (await res.json()) as WttjResponse;
  const jobs = data ?? [];
  all.push(...jobs);

  return all;
}

function jobToMarkdown(job: WttjJob, org: string): string {
  const city = job.office?.city ?? "";
  const country = job.office?.country_code ?? "";
  const location = [city, country].filter(Boolean).join(", ");
  const orgSlug = orgs.find((o) => o.id === org)?.slug;
  const jobUrl = `https://www.welcometothejungle.com/fr/companies/${orgSlug}/`;

  const lines: string[] = [
    "---",
    `title: ${JSON.stringify(job.name)}`,
    `organization: ${JSON.stringify(org)}`,
    `url: ${JSON.stringify(jobUrl)}`,
  ];
  if (location) lines.push(`location: ${JSON.stringify(location)}`);
  if (job.contract_type)
    lines.push(`contract: ${JSON.stringify(job.contract_type)}`);
  if (job.remote) lines.push(`remote: ${JSON.stringify(job.remote)}`);
  if (job.apply_url) lines.push(`apply_url: ${JSON.stringify(job.apply_url)}`);
  if (job.published_at)
    lines.push(`published_at: ${JSON.stringify(job.published_at)}`);
  lines.push("---", "");

  const parts: string[] = [];
  parts.push(jobUrl);
  if (job.description) parts.push(stripHtml(job.description));
  if (job.profile) parts.push(stripHtml(job.profile));
  if (parts.length) lines.push(parts.join("\n\n"));

  return lines.join("\n");
}

async function main() {
  for (const org of orgs.map((o) => o.id)) {
    console.log(`Fetching jobs for org: ${org}`);
    const orgDir = path.join(DATA_DIR, "wttj", org);
    fs.mkdirSync(orgDir, { recursive: true });

    for (const f of fs.readdirSync(orgDir)) {
      if (f.endsWith(".md")) fs.rmSync(path.join(orgDir, f));
    }

    const jobs = await fetchJobs(org);
    console.log(`  ${jobs.length} jobs found`);

    for (const job of jobs) {
      const slug = job.reference.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
      fs.writeFileSync(
        path.join(orgDir, `${slug}.md`),
        jobToMarkdown(job, org),
      );
    }

    console.log(`  Written to ${orgDir}/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

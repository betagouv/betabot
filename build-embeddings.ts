import fs from "fs";
import path from "path";
import crypto from "crypto";
import { embedBatch, saveBin } from "./src/embed.js";
import { buildBM25Index, saveBM25Index } from "./src/search.js";
import { parseFrontmatter, extractSections } from "./src/markdown.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const FORCE = process.argv.includes("--force");

function computeTextsHash(texts: string[]): string {
  return crypto.createHash("sha256").update(texts.join("\0")).digest("hex");
}

function loadSavedHash(binPath: string): string | null {
  try {
    return fs.readFileSync(binPath + ".hash", "utf-8").trim();
  } catch {
    return null;
  }
}

function saveHash(binPath: string, hash: string): void {
  fs.writeFileSync(binPath + ".hash", hash);
}

function needsRebuild(binPath: string, texts: string[]): boolean {
  if (FORCE) return true;
  if (!fs.existsSync(binPath)) return true;
  const hash = computeTextsHash(texts);
  if (loadSavedHash(binPath) === hash) {
    console.log(`  ↩ Content unchanged, skipping`);
    return false;
  }
  return true;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberEntry {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  competences: string[];
}

interface StartupEntry {
  id: string;
  name: string;
  description: string;
  active_member_count: number;
}

interface RepoEntry {
  org: string;
  repo: string;
  name: string;
  description: string;
  language: string;
  tags: string[];
}

interface DocChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
  url?: string;
}

interface IncubatorEntry {
  id: string;
  title: string;
  contact: string;
  website: string | null;
  github: string | null;
  startup_count: number;
  startups_summary: string;
}

interface RawIncubatorStartup {
  id: string;
  name: string;
  pitch: string;
  repository: string | null;
  contact: string;
  phases: Array<{ name: string; start: string }>;
}

interface RawIncubator {
  title: string;
  owner: string;
  contact: string;
  address: string | null;
  website: string | null;
  github: string | null;
  startups: RawIncubatorStartup[];
}

interface VideoChunk {
  title: string;
  channel: string;
  url: string;
  date: string;
  description: string;
}

interface PeertubeItem {
  id: string;
  url: string;
  title: string;
  summary?: string;
  content_html?: string;
  date_published?: string;
  date_modified?: string;
}

interface PeertubeChannel {
  items?: PeertubeItem[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function excerpt(text: string, maxLen = 200): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── Job 1: Members ───────────────────────────────────────────────────────────

async function buildMembersEmbeddings() {
  console.log("\n[1/9] Building members embeddings…");
  const members = readJson<MemberEntry[]>(
    path.join(DATA_DIR, "index/members.json"),
  );

  // todo: remove expired ?
  const texts = members.map(
    (m) =>
      `${m.fullname}, ${m.role}, domaine ${m.domaine}. Compétences: ${
        (m.competences ?? []).join(", ") || "non renseignées"
      }`,
  );

  const binPath = path.join(DATA_DIR, "index/members.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatch(texts);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/members.bm25.json"));

  console.log(`  ✓ ${members.length} members embedded`);
}

// ─── Job 2: Startups index ───────────────────────────────────────────────────

async function buildStartupsEmbeddings() {
  console.log("\n[2/9] Building startups index embeddings…");
  const startups = readJson<StartupEntry[]>(
    path.join(DATA_DIR, "index/startups.json"),
  );

  // todo: remove abandon-* ?
  const texts = startups.map((s) => `${s.name}: ${s.description}`);
  const binPath = path.join(DATA_DIR, "index/startups.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatch(texts);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/startups.bm25.json"));

  console.log(`  ✓ ${startups.length} startups embedded`);
}

// ─── Job 3: Gitscan repos ────────────────────────────────────────────────────

async function buildReposEmbeddings() {
  console.log("\n[3/9] Building gitscan repos embeddings…");
  const reposDir = path.join(DATA_DIR, "gitscan/repos");
  const entries: RepoEntry[] = [];
  const texts: string[] = [];

  const orgs = fs.readdirSync(reposDir).filter((f) => {
    try {
      return fs.statSync(path.join(reposDir, f)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const org of orgs) {
    const orgDir = path.join(reposDir, org);
    const repos = fs.readdirSync(orgDir).filter((f) => {
      try {
        return fs.statSync(path.join(orgDir, f)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const repo of repos) {
      const overviewPath = path.join(orgDir, repo, "overview.json");
      if (!fs.existsSync(overviewPath)) continue;

      try {
        const ov = readJson<{
          name: string;
          description: string;
          language: string;
          tags: string[];
          features: string[];
          audience: string;
        }>(overviewPath);

        const text =
          `${ov.name} (${org}): ${ov.description ?? ""}. ` +
          `Language: ${ov.language ?? ""}. ` +
          `Tags: ${(ov.tags ?? []).join(", ")}. ` +
          `Features: ${(ov.features ?? []).join(", ")}. ` +
          `Audience: ${ov.audience ?? ""}`;

        entries.push({
          org,
          repo,
          name: ov.name,
          description: ov.description ?? "",
          language: ov.language ?? "",
          tags: ov.tags ?? [],
        });
        texts.push(text);
      } catch {
        // Skip repos with broken overview.json
      }
    }
  }

  const binPath = path.join(DATA_DIR, "gitscan/repos.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatch(texts);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "gitscan/repos.bm25.json"));
  writeJson(path.join(DATA_DIR, "gitscan/repos.index.json"), entries);

  console.log(`  ✓ ${entries.length} repos embedded`);
}

// ─── Shared markdown-docs helper ─────────────────────────────────────────────

async function buildMdDocsEmbeddings(
  label: string,
  sourceDirs: string[],
  outDir: string,
  emptyMsg = "No doc files found",
): Promise<void> {
  const chunks: DocChunk[] = [];
  const texts: string[] = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.endsWith(".md")) {
        processDocFile(fullPath);
      }
    }
  }

  function processDocFile(filePath: string) {
    const relativePath = path.relative(outDir, filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }
    const { data: fm } = parseFrontmatter(content);
    const pageTitle =
      (fm["title"] as string | undefined) ?? path.basename(filePath, ".md");
    const url = fm["url"] as string | undefined;

    if (fm["description"]) {
      const desc = String(fm["description"]);
      chunks.push({
        path: relativePath,
        title: pageTitle,
        breadcrumb: pageTitle,
        excerpt: excerpt(desc),
        url,
      });
      texts.push(`[${pageTitle}]\n${desc}`);
    }

    const sections = extractSections(content);
    for (const section of sections) {
      if (section.content.length < 30) continue;
      chunks.push({
        path: relativePath,
        title: pageTitle,
        breadcrumb: section.breadcrumb,
        excerpt: excerpt(section.content),
        url,
      });
      texts.push(`[${section.breadcrumb}]\n${excerpt(section.content, 6000)}`);
    }
  }

  for (const dir of sourceDirs) {
    if (fs.existsSync(dir)) walkDir(dir);
  }

  if (texts.length === 0) {
    console.log(`  ⚠ ${emptyMsg}, skipping`);
    return;
  }

  const binPath = path.join(outDir, "docs.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatch(texts);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(outDir, "docs.bm25.json"));
  writeJson(path.join(outDir, "docs.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} ${label} chunks embedded`);
}

// ─── Job 4: Docs ─────────────────────────────────────────────────────────────

async function buildDocsEmbeddings() {
  console.log("\n[4/9] Building docs embeddings…");
  const docsDir = path.join(DATA_DIR, "doc.incubateur.net");
  await buildMdDocsEmbeddings("doc", [docsDir], docsDir, "No doc files found");
}

// ─── Job 5: PeerTube videos ───────────────────────────────────────────────────

async function buildVideosEmbeddings() {
  console.log("\n[5/9] Building PeerTube videos embeddings…");
  const peertubeDir = path.join(DATA_DIR, "peertube");

  if (!fs.existsSync(peertubeDir)) {
    console.log("  ⚠ peertube directory not found, skipping");
    return;
  }

  const files = fs
    .readdirSync(peertubeDir)
    .filter((f) => f.endsWith(".json") && f !== "videos.index.json");

  const chunks: VideoChunk[] = [];
  const texts: string[] = [];

  for (const file of files) {
    const channelName = path.basename(file, ".json");
    let feed: PeertubeChannel;
    try {
      feed = readJson<PeertubeChannel>(path.join(peertubeDir, file));
    } catch {
      continue;
    }

    for (const item of feed.items ?? []) {
      const title = item.title ?? "(sans titre)";
      const url = item.url ?? item.id ?? "";
      const date = item.date_published ?? "";
      const description = item.content_html
        ? stripHtml(item.content_html)
        : (item.summary ?? "");
      chunks.push({ title, channel: channelName, url, date, description });
      texts.push(
        description
          ? `[${channelName}] ${title}\n${description}`
          : `[${channelName}] ${title}`,
      );
    }
  }

  if (texts.length === 0) {
    console.log("  ⚠ No videos found, skipping");
    return;
  }

  const binPath = path.join(peertubeDir, "videos.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatch(texts);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(peertubeDir, "videos.bm25.json"));
  writeJson(path.join(peertubeDir, "videos.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} videos embedded`);
}

// ─── Job 7: ProConnect docs ──────────────────────────────────────────────────

async function buildProconnectDocsEmbeddings() {
  console.log("\n[7/9] Building ProConnect docs embeddings…");
  const dir = path.join(DATA_DIR, "docs-proconnect");
  await buildMdDocsEmbeddings(
    "ProConnect",
    [dir],
    dir,
    "No ProConnect doc files found",
  );
}

// ─── Job 6: Incubators ───────────────────────────────────────────────────────

async function buildIncubatorsEmbeddings() {
  console.log("\n[6/9] Building incubators embeddings…");
  const raw = readJson<Record<string, RawIncubator>>(
    path.join(DATA_DIR, "API/incubators.json"),
  );

  const entries: IncubatorEntry[] = [];
  const texts: string[] = [];

  for (const [id, incubator] of Object.entries(raw)) {
    const startupNames = incubator.startups
      .slice(0, 10)
      .map((s) => s.name)
      .join(", ");
    const summary =
      incubator.startups.length > 10
        ? `${startupNames}… (${incubator.startups.length} startups)`
        : startupNames;

    entries.push({
      id,
      title: incubator.title,
      contact: incubator.contact,
      website: incubator.website,
      github: incubator.github,
      startup_count: incubator.startups.length,
      startups_summary: summary,
    });

    texts.push(`${incubator.title} — startups: ${summary}`);
  }

  const binPath = path.join(DATA_DIR, "API/incubators.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatch(texts);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "API/incubators.bm25.json"));
  writeJson(path.join(DATA_DIR, "API/incubators.index.json"), entries);

  console.log(`  ✓ ${entries.length} incubators embedded`);
}

// ─── Job 8: FranceConnect docs ───────────────────────────────────────────────

async function buildFranceconnectDocsEmbeddings() {
  console.log("\n[8/9] Building FranceConnect docs embeddings…");
  const dir = path.join(DATA_DIR, "docs-franceconnect");
  await buildMdDocsEmbeddings(
    "FranceConnect",
    [dir],
    dir,
    "No FranceConnect doc files found",
  );
}

// ─── Job 9: DSFR docs ────────────────────────────────────────────────────────

async function buildDsfrDocsEmbeddings() {
  console.log("\n[9/9] Building DSFR docs embeddings…");
  const baseDir = path.join(DATA_DIR, "docs-dsfr");
  const subdirs = ["premiers-pas", "fondamentaux"].map((s) =>
    path.join(baseDir, s),
  );
  await buildMdDocsEmbeddings(
    "DSFR",
    subdirs,
    baseDir,
    "No DSFR doc files found",
  );
}

// ─── Job 10: WTTJ job offers ─────────────────────────────────────────────────

async function buildWttjEmbeddings() {
  console.log("\n[10/10] Building WTTJ job offers embeddings…");
  const baseDir = path.join(DATA_DIR, "wttj");
  if (!fs.existsSync(baseDir)) {
    console.log("  ⚠ wttj directory not found, skipping");
    return;
  }
  const orgDirs = fs
    .readdirSync(baseDir)
    .map((f) => path.join(baseDir, f))
    .filter((f) => {
      try {
        return fs.statSync(f).isDirectory();
      } catch {
        return false;
      }
    });
  await buildMdDocsEmbeddings("WTTJ", orgDirs, baseDir, "No WTTJ job offers found");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("betabot — build-embeddings");
  console.log("===========================");
  const t0 = Date.now();

  await buildMembersEmbeddings();
  await buildStartupsEmbeddings();
  await buildReposEmbeddings();
  await buildDocsEmbeddings();
  await buildVideosEmbeddings();
  await buildIncubatorsEmbeddings();
  await buildProconnectDocsEmbeddings();
  await buildFranceconnectDocsEmbeddings();
  await buildDsfrDocsEmbeddings();
  await buildWttjEmbeddings();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

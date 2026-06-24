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

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
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

// ─── Per-item embedding cache ────────────────────────────────────────────────

const CACHE_BIN = path.join(DATA_DIR, "embeddings-cache.bin");
const CACHE_IDX = path.join(DATA_DIR, "embeddings-cache.index.json");

interface CacheIndex {
  dims: number;
  entries: Record<string, number>;
}

function loadEmbeddingCache(): Map<string, number[]> {
  const cache = new Map<string, number[]>();
  if (!fs.existsSync(CACHE_IDX) || !fs.existsSync(CACHE_BIN)) return cache;
  try {
    const { dims, entries } = JSON.parse(
      fs.readFileSync(CACHE_IDX, "utf-8"),
    ) as CacheIndex;
    const buf = fs.readFileSync(CACHE_BIN);
    const matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    for (const [hash, row] of Object.entries(entries)) {
      cache.set(hash, Array.from(matrix.subarray(row * dims, (row + 1) * dims)));
    }
    console.log(`  cache: ${cache.size} entries loaded`);
  } catch {
    // corrupt cache — start fresh
  }
  return cache;
}

function saveEmbeddingCache(cache: Map<string, number[]>): void {
  if (cache.size === 0) return;
  const entries: Record<string, number> = {};
  const allVecs: number[][] = [];
  for (const [hash, vec] of cache.entries()) {
    entries[hash] = allVecs.length;
    allVecs.push(vec);
  }
  const dims = allVecs[0].length;
  const buffer = Buffer.allocUnsafe(allVecs.length * dims * 4);
  for (let i = 0; i < allVecs.length; i++) {
    for (let j = 0; j < dims; j++) {
      buffer.writeFloatLE(allVecs[i][j], (i * dims + j) * 4);
    }
  }
  fs.writeFileSync(CACHE_BIN, buffer);
  fs.writeFileSync(CACHE_IDX, JSON.stringify({ dims, entries }));
}

async function embedBatchCached(
  texts: string[],
  cache: Map<string, number[]>,
): Promise<number[][]> {
  const hashes = texts.map(sha256);
  const toEmbed = texts
    .map((t, i) => ({ i, t }))
    .filter((x) => !cache.has(hashes[x.i]));

  if (toEmbed.length < texts.length) {
    process.stdout.write(
      `  cache: ${texts.length - toEmbed.length}/${texts.length} hits\n`,
    );
  }

  if (toEmbed.length > 0) {
    const newVecs = await embedBatch(toEmbed.map((x) => x.t));
    toEmbed.forEach((x, j) => cache.set(hashes[x.i], newVecs[j]));
  }

  return hashes.map((h) => cache.get(h)!);
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

async function buildMembersEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[1/11] Building members embeddings…");
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

  const vecs = await embedBatchCached(texts, cache);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/members.bm25.json"));

  console.log(`  ✓ ${members.length} members embedded`);
}

// ─── Job 2: Startups index ───────────────────────────────────────────────────

async function buildStartupsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[2/11] Building startups index embeddings…");
  const startups = readJson<StartupEntry[]>(
    path.join(DATA_DIR, "index/startups.json"),
  );

  // todo: remove abandon-* ?
  const texts = startups.map((s) => `${s.name}: ${s.description}`);
  const binPath = path.join(DATA_DIR, "index/startups.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatchCached(texts, cache);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "index/startups.bm25.json"));

  console.log(`  ✓ ${startups.length} startups embedded`);
}

// ─── Job 3: Gitscan repos ────────────────────────────────────────────────────

async function buildReposEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[3/11] Building gitscan repos embeddings…");
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

  const vecs = await embedBatchCached(texts, cache);
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
  cache: Map<string, number[]>,
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

  const vecs = await embedBatchCached(texts, cache);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(outDir, "docs.bm25.json"));
  writeJson(path.join(outDir, "docs.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} ${label} chunks embedded`);
}

// ─── Job 4: Docs ─────────────────────────────────────────────────────────────

async function buildDocsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[4/11] Building docs embeddings…");
  const docsDir = path.join(DATA_DIR, "doc.incubateur.net");
  await buildMdDocsEmbeddings("doc", [docsDir], docsDir, cache, "No doc files found");
}

// ─── Job 5: PeerTube videos ───────────────────────────────────────────────────

async function buildVideosEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[5/11] Building PeerTube videos embeddings…");
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

  const vecs = await embedBatchCached(texts, cache);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(peertubeDir, "videos.bm25.json"));
  writeJson(path.join(peertubeDir, "videos.index.json"), chunks);

  console.log(`  ✓ ${chunks.length} videos embedded`);
}

// ─── Job 7: ProConnect docs ──────────────────────────────────────────────────

async function buildProconnectDocsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[7/11] Building ProConnect docs embeddings…");
  const dir = path.join(DATA_DIR, "docs-proconnect");
  await buildMdDocsEmbeddings(
    "ProConnect",
    [dir],
    dir,
    cache,
    "No ProConnect doc files found",
  );
}

// ─── Job 6: Incubators ───────────────────────────────────────────────────────

async function buildIncubatorsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[6/11] Building incubators embeddings…");
  const raw = readJson<Record<string, RawIncubator>>(
    path.join(DATA_DIR, "API/incubators.json"),
  );

  const entries: IncubatorEntry[] = [];
  const texts: string[] = [];

  for (const [id, incubator] of Object.entries(raw)) {
    const startups = incubator.startups || [];
    const startupNames = startups
      .slice(0, 10)
      .map((s) => s.name)
      .join(", ");
    const summary =
      startups.length > 10
        ? `${startupNames}… (${startups.length} startups)`
        : startupNames;

    entries.push({
      id,
      title: incubator.title,
      contact: incubator.contact,
      website: incubator.website,
      github: incubator.github,
      startup_count: startups.length,
      startups_summary: summary,
    });

    texts.push(`${incubator.title} — startups: ${summary}`);
  }

  const binPath = path.join(DATA_DIR, "API/incubators.embeddings.bin");
  if (!needsRebuild(binPath, texts)) return;

  const vecs = await embedBatchCached(texts, cache);
  saveBin(vecs, binPath);
  saveHash(binPath, computeTextsHash(texts));

  const bm25 = await buildBM25Index(texts);
  saveBM25Index(bm25, path.join(DATA_DIR, "API/incubators.bm25.json"));
  writeJson(path.join(DATA_DIR, "API/incubators.index.json"), entries);

  console.log(`  ✓ ${entries.length} incubators embedded`);
}

// ─── Job 8: FranceConnect docs ───────────────────────────────────────────────

async function buildFranceconnectDocsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[8/11] Building FranceConnect docs embeddings…");
  const dir = path.join(DATA_DIR, "docs-franceconnect");
  await buildMdDocsEmbeddings(
    "FranceConnect",
    [dir],
    dir,
    cache,
    "No FranceConnect doc files found",
  );
}

// ─── Job 9: DSFR docs ────────────────────────────────────────────────────────

async function buildDsfrDocsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[9/11] Building DSFR docs embeddings…");
  const baseDir = path.join(DATA_DIR, "docs-dsfr");
  const subdirs = ["premiers-pas", "fondamentaux"].map((s) =>
    path.join(baseDir, s),
  );
  await buildMdDocsEmbeddings(
    "DSFR",
    subdirs,
    baseDir,
    cache,
    "No DSFR doc files found",
  );
}

// ─── Job 10: WTTJ job offers ─────────────────────────────────────────────────

async function buildWttjEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[10/11] Building WTTJ job offers embeddings…");
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
  await buildMdDocsEmbeddings(
    "WTTJ",
    orgDirs,
    baseDir,
    cache,
    "No WTTJ job offers found",
  );
}

// ─── Job 11: Messagerie docs ─────────────────────────────────────────────────

async function buildMessagerieDocsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[11/11] Building messagerie docs embeddings…");
  const dir = path.join(DATA_DIR, "docs-messagerie");
  await buildMdDocsEmbeddings(
    "messagerie",
    [dir],
    dir,
    cache,
    "No messagerie doc files found",
  );
}

// ─── Job 12: Tchap docs ──────────────────────────────────────────────────────

async function buildTchapDocsEmbeddings(cache: Map<string, number[]>) {
  console.log("\n[12/12] Building Tchap docs embeddings…");
  const dir = path.join(DATA_DIR, "docs-tchap");
  await buildMdDocsEmbeddings(
    "Tchap",
    [dir],
    dir,
    cache,
    "No Tchap doc files found",
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("betabot — build-embeddings");
  console.log("===========================");
  const t0 = Date.now();

  const cache = FORCE ? new Map<string, number[]>() : loadEmbeddingCache();

  await buildMembersEmbeddings(cache);
  await buildStartupsEmbeddings(cache);
  await buildReposEmbeddings(cache);
  await buildDocsEmbeddings(cache);
  await buildVideosEmbeddings(cache);
  await buildIncubatorsEmbeddings(cache);
  await buildProconnectDocsEmbeddings(cache);
  await buildFranceconnectDocsEmbeddings(cache);
  await buildDsfrDocsEmbeddings(cache);
  await buildWttjEmbeddings(cache);
  await buildMessagerieDocsEmbeddings(cache);
  await buildTchapDocsEmbeddings(cache);

  saveEmbeddingCache(cache);
  console.log(`  cache: ${cache.size} entries saved`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
